import { Octokit } from "@octokit/rest";
import axios from "axios";
import fs from "fs";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

// ✅ Get current PR number
const eventPath = process.env.GITHUB_EVENT_PATH;
const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const prNumber = eventData.pull_request?.number;

if (!prNumber) {
	console.error("❌ Cannot determine pull request number.");
	process.exit(1);
}

// ---------- CONFIGURATION ----------
const MODEL = "gemini-2.5-flash"; // or gemini-2.5-pro for higher accuracy
const REVIEW_MODE = process.env.REVIEW_MODE || "full"; // "inline", "summary", or "full"
const REVIEW_LANGUAGE = process.env.REVIEW_LANGUAGE || "ASP.NET Core (C# backend) and Angular (TypeScript frontend)"; // Specify the project language/context here
// ----------------------------------

const summaryFormat = `
	Format your response as follows:

	### 🔍 Summary
	Give a short summary (2-3 lines) of your general impression.

	### 💬 Detailed Review
	List bullet points with specific findings, grouped by category if possible.

	### ✅ Suggestions
	Propose concrete improvements or refactor ideas.

	If the code is already good, say so explicitly and mention what's done well.
  `;

const inlineFormat = `
	Return ONLY a **pure JSON array**, no markdown, no text before or after.
	Format:
	[
	{
		"file": "filename.extension",
		"line": <The position in the diff where you want to add a review comment. Note this value is not the same as the line number in the file. The position value equals the number of lines down from the first "@@" hunk header in the file you want to add a comment. The line just below the "@@" line is position 1, the next line is position 2, and so on. The position in the diff continues to increase through lines of whitespace and additional hunks until the beginning of a new file.>,
		"comment": "clear actionable feedback"
	}
	]

	Rules:
	- Line numbers must match the diff chunk's new code lines.
	- Skip trivial stylistic issues (like missing semicolon).
	- Return [] if everything is good.
	- Do not wrap your response in markdown. Do not say anything else.
  `;

function getDiffPosition(patch, targetLine) {
	if (!patch) return null;
	const lines = patch.split("\n");
	let fileLine = 0;
	let position = 0;
	for (const line of lines) {
		position++;
		if (line.startsWith("@@")) {
			const match = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
			if (match) fileLine = parseInt(match[1], 10) - 1;
		} else if (line.startsWith("+")) {
			fileLine++;
			if (fileLine === targetLine) return position;
		} else if (!line.startsWith("-")) {
			fileLine++;
		}
	}
	return null;
}

// Helper to call Gemini
async function callGemini(promptText, apiKey) {
	const res = await axios.post(
		`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
		{
			contents: [{ parts: [{ text: promptText }] }],
		}
	);
	return res.data.candidates?.[0]?.content?.parts?.[0]?.text;
}

async function main() {
	console.log(`📦 Fetching changed files for PR #${prNumber}...`);

	const { data: files } = await octokit.pulls.listFiles({
		owner,
		repo,
		pull_number: prNumber,
	});

	if (!files.length) {
		console.log("⚠️ No files changed in this PR.");
	}

	let fileDiffs = "";
	for (const file of files) {
		if (file.patch) {
			fileDiffs += `\nFile: ${file.filename}\n${file.patch}\n`;
		}
	}

	let reviewPrompt = `
  	Context: This project is a web-based ERP system built using ${REVIEW_LANGUAGE}.
 	You are an experienced senior software engineer acting as an automated code reviewer.
	You will receive one or more source code diffs from a Pull Request.

	Your task:
	- Analyze only the changed code (not the entire file).
	- Provide a professional, concise, and actionable code review in Markdown format.

	Focus on the following criteria:

	1. **Code Standard & Style**
	- Check if the code follows clean coding conventions.
	- Identify inconsistent indentation, spacing, or bad formatting.
	- Verify naming conventions according to language standards (C#, TypeScript, HTML, CSS, etc.).
	- Detect "magic numbers", deeply nested code, or unclear function structures.

	2. **Readability & Naming**
	- Evaluate whether variable, method, and class names are descriptive and meaningful.
	- Highlight any ambiguous or confusing naming.
	- Suggest clearer alternatives where appropriate.

	3. **Security & Robustness**
	- Detect missing null checks, unvalidated inputs, or unsafe assumptions.
	- Check for missing try/catch or improper exception handling.
	- Identify potential SQL injection, XSS, or insecure data handling.
	- Ensure sensitive data (passwords, tokens, API keys) are not exposed.

	4. **Performance & Optimization**
	- Identify inefficient loops, redundant computations, or unnecessary allocations.
	- Suggest refactoring or using more optimal data structures or APIs.
	- For front-end code, note inefficient DOM manipulation or heavy re-renders.

	5. **Best Practices**
	- Check if code is modular, reusable, and easy to test.
	- Identify potential violations of SOLID, DRY, or KISS principles.
	- Suggest adding comments or documentation if logic is complex.
  `;

	console.log("🤖 Sending diff to Gemini...");

	// ---------- INLINE REVIEW ----------
	if (REVIEW_MODE === "inline" || REVIEW_MODE === "full") {
		console.log("💬 Generating inline comments...");
		const inlineResponse = await callGemini(
			`${reviewPrompt}\n\n${inlineFormat}\n\n${fileDiffs}`,
			process.env.GEMINI_API_KEY
		);

		let inlineComments = [];
		try {
			const cleaned = inlineResponse
				?.replace(/```json/g, "")
				?.replace(/```/g, "")
				?.trim();
			inlineComments = JSON.parse(cleaned);
			console.log("Generated inline comments:", inlineComments);
		} catch (err) {
			console.error("⚠️ Gemini returned invalid JSON for inline review:");
			console.log(inlineResponse);
		}

		if (inlineComments.length) {
			try {
				const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
				const commitSha = pr.data.head.sha;

				/* for (const c of inlineComments) {
					const f = files.find((ff) => ff.filename === c.path);
					if (!f) continue;
					c.position = getDiffPosition(f.patch, c.line);
				} */

				await octokit.pulls.createReview({
					owner,
					repo,
					pull_number: prNumber,
					event: "COMMENT",
					commit_id: commitSha,
					comments: inlineComments.map((c) => ({
						path: c.file,
						position: c.line,
						body: `💡 ${c.comment}`,
					})),
				});
			} catch (err) {
				console.error(`❌ Failed to createReview: `, err.message);
				console.log("Generated inline comments:", inlineComments);
			}
			console.log(`✅ Added ${inlineComments.length} inline comments.`);
		} else {
			console.log("✅ No inline issues found.");
		}
	}

	// ---------- SUMMARY REVIEW ----------
	if (REVIEW_MODE === "summary" || REVIEW_MODE === "full") {
		console.log("🧠 Generating summary review...");
		const summaryResponse = await callGemini(
			`${reviewPrompt}\n\n${summaryFormat}\n\n${fileDiffs}`,
			process.env.GEMINI_API_KEY_2
		);

		if (summaryResponse) {
			await octokit.issues.createComment({
				owner,
				repo,
				issue_number: prNumber,
				body: `🤖 **Gemini Summary Review**\n\n${summaryResponse}`,
			});
			console.log("✅ Summary review posted.");
		} else {
			console.log("⚠️ No summary review generated.");
			console.log("Response:", summaryResponse);
		}
	}

	console.log("🏁 Review completed.");
}

main().catch((err) => {
	console.error("❌ Error:", err.response?.data || err.message);
	process.exit(1);
});
