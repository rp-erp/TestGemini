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
		"position": <the correct diff line index (integer), based on the provided patch (NOT the original file line number)>,
		"comment": "clear actionable feedback"
	}
	]

	How to find "position":
	- Count from the top of the diff patch (first line = position 1).
	- Only comment on lines starting with "+" (added or changed lines).
	- The "position" must match the line's index **within the diff**, not the real file.

	Rules:
	- Line numbers must match the diff chunk's new code lines.
	- Skip trivial stylistic issues (like missing semicolon).
	- Return [] if everything is good.
	- Do not wrap your response in markdown. Do not say anything else.
  `;

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
		} catch (err) {
			console.error("⚠️ Gemini returned invalid JSON for inline review:");
			console.log(inlineResponse);
		}

		if (inlineComments.length) {
			try {
				await octokit.pulls.createReview({
					owner,
					repo,
					pull_number: prNumber,
					event: "COMMENT",
					comments: inlineComments.map((c) => ({
						path: c.file,
						position: c.line, // line number in the diff
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
