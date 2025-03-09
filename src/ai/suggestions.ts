import type { Context } from "probot";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

import type { Logger } from "../types/index.js";
import { createReviewComment } from "../services/github.js";

const PROMPT_BASE = `<internal_reminder>

1. <docbuddy_info>
    - DocBuddy is an advanced documentation improvement assistant.
    - DocBuddy analyzes Markdown documentation to provide improved versions.
    - DocBuddy focuses on clarity, conciseness, and technical accuracy.
    - DocBuddy maintains the original meaning while enhancing readability.
    - DocBuddy has knowledge of Markdown, documentation best practices, and technical writing.
2. <docbuddy_capabilities>
    - Analyzes individual Markdown paragraphs to identify areas for improvement.
    - Enhances clarity without changing technical meaning.
    - Improves structure and readability of each paragraph.
    - Standardizes Markdown formatting according to best practices.
    - Provides specific and actionable suggestions for each paragraph.
3. <docbuddy_response_format>
    - DocBuddy MUST return responses in the format: "reason: [REASON WHY THE CHANGE IS NEEDED]\\nsuggestion: [IMPROVED TEXT]"
    - The reason should briefly explain the improvement.
    - The suggestion should be the improved version of the text only.
    - Both parts are required in this exact format.
    - Example:
      reason: The sentence is fragmented and unclear.
      suggestion: This is the improved, clearer version of the text.
4. <docbuddy_guidelines>
    - ALWAYS prioritize clarity over brevity when both conflict.
    - MAINTAIN Markdown-specific syntax and formatting.
    - PRESERVE the complete meaning of the original text.
    - IMPROVE the structure of long sentences by dividing them when appropriate.
    - ELIMINATE redundancies and superfluous text.
    - ENSURE proper Markdown formatting.
    - Make each suggestion SPECIFIC and ACTIONABLE.
    - Address the specific issues in the content while maintaining original intent.
5. <forming_correct_responses>
    - ALWAYS follow the response format: "reason: [explanation]\\nsuggestion: [improved text]"
    - Keep reasons brief but specific (1-2 sentences).
    - The suggestion part should contain ONLY the improved text.
    - If no improvements are possible, say "reason: No improvements needed." and repeat the original text in the suggestion.
    - Only the suggestion part will replace the original text.

</internal_reminder>

This is the text you should review:`;

/**
 * Analyzes a patch and generates AI-powered improvement suggestions for Markdown documentation
 */
export async function createDocumentationSuggestions(
  context: Context,
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  filePath: string,
  patch: string,
  logger: Logger
) {
  try {
    // Parse the patch to find added or modified lines
    const lines = patch.split("\n");

    // Collect all documentation lines and their positions
    const docLines: { line: number; codeLine: string }[] = [];

    // Process each line in the patch to identify documentation
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for lines that start with '+' (added/modified) but not metadata lines (+++/---)
      if (line.startsWith("+") && !line.startsWith("+++")) {
        // Get the line without the '+' prefix
        const codeLine = line.substring(1);

        // Add the line to our collection
        docLines.push({ line: i, codeLine });
      }
    }

    // If there are no lines to improve, exit
    if (docLines.length === 0) {
      logger.info("No documentation lines found to improve");
      return 0;
    }

    logger.info(`Found ${docLines.length} lines to improve in file ${filePath}`);

    // Create individual suggestions for each line
    let successCount = 0;

    // Process each line individually
    for (const doc of docLines) {
      try {
        // Process each line separately
        const success = await processIndividualLine(
          context,
          owner,
          repo,
          pullNumber,
          commitId,
          filePath,
          doc,
          lines,
          logger
        );

        if (success) {
          successCount++;
        }
      } catch (lineError) {
        logger.error(`Error processing line: ${lineError}`);
        // Continue with next line
      }
    }

    logger.info(`Created ${successCount} individual line suggestions`);
    return successCount;

  } catch (error) {
    logger.error(`Error analyzing patch and creating suggestions: ${error}`);
    // Always return success to prevent failures
    return 0;
  }
}

/**
 * Processes a single line and generates an individual improvement suggestion
 */
async function processIndividualLine(
  context: Context,
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  filePath: string,
  doc: { line: number; codeLine: string },
  lines: string[],
  logger: Logger
): Promise<boolean> {
  try {
    // Skip empty lines
    if (!doc.codeLine.trim()) {
      return false;
    }

    // Use AI to improve the line
    const { text } = await generateText({
      model: openai("gpt-4"),
      system: PROMPT_BASE,
      prompt: doc.codeLine,
    }).catch(error => {
      logger.error(`AI generation error for line: ${error}`);
      return { text: "" };
    });

    // If no improvement was generated, skip
    if (!text) {
      return false;
    }

    // Check if the response follows the expected format
    if (text.includes("reason:") && text.includes("suggestion:")) {
      // Use the formatted suggestion
      const body = formatSuggestionComment(text);

      // Calculate the position in the file
      const position = calculatePositionInFile(lines, doc.line);

      // Create a review comment for this specific line
      await createReviewComment(
        context,
        owner,
        repo,
        pullNumber,
        body,
        commitId,
        filePath,
        position,
        logger
      );

      logger.info(`Created individual suggestion with reason for line at position ${position}`);
      return true;
    }

    // If response doesn't follow the format, check if it's different from original
    if (text.trim() === doc.codeLine.trim()) {
      return false;
    }

    // Use simple suggestion format as fallback
    const body = formatLineSuggestion(doc.codeLine, text);

    // Calculate the position in the file
    const position = calculatePositionInFile(lines, doc.line);

    // Create a review comment for this specific line
    await createReviewComment(
      context,
      owner,
      repo,
      pullNumber,
      body,
      commitId,
      filePath,
      position,
      logger
    );

    logger.info(`Created simple suggestion for line at position ${position}`);
    return true;
  } catch (error) {
    logger.error(`Error processing line: ${error}`);
    return false;
  }
}

/**
 * Calculates the position in a file based on the patch
 */
function calculatePositionInFile(lines: string[], lineIndex: number): number {
  try {
    // Position calculation is tricky in GitHub's API
    // The best approximation is to use the line number from the @@ markers
    // and count from there, skipping removed lines

    let position = 1;
    let currentHunkStart = 0;
    let linesAfterHunkStart = 0;

    for (let j = 0; j < lineIndex; j++) {
      const line = lines[j];
      if (line?.startsWith("@@ ")) {
        const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
        if (match?.[1]) {
          currentHunkStart = Number.parseInt(match[1], 10);
          linesAfterHunkStart = 0;
        }
      } else if (line?.startsWith("+")) {
        linesAfterHunkStart++;
      } else if (!line?.startsWith("-")) {
        linesAfterHunkStart++;
      }
    }

    position = currentHunkStart + linesAfterHunkStart;

    // Ensure position is at least 1
    return Math.max(position, 1);
  } catch (error) {
    // In case of any error in calculation, return a safe default
    console.error(`Error calculating file position: ${error}`);
    return 1;
  }
}

/**
 * Formats a suggestion comment that includes a reason
 */
function formatSuggestionComment(content: string): string {
  // Split the content into reason and suggestion
  const parts = content.split("\nsuggestion:");
  if (parts.length !== 2) {
    return content; // Return original content if format is not as expected
  }

  const reason = parts[0].replace("reason:", "").trim();
  const suggestion = parts[1].trim();

  return [
    `**Reason for improvement:** ${reason}`,
    "```suggestion",
    suggestion,
    "```",
  ].join("\n");
}

/**
 * Formats a simple line-specific suggestion comment without reason
 */
function formatLineSuggestion(_original: string, improved: string): string {
  return [
    "```suggestion",
    improved,
    "```"
  ].join("\n");
}
