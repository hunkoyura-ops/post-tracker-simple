import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const metricsExtractionTool = {
  name: "extract_metrics",
  description:
    "Витягує метрики зі скриншота статистики поста. Якщо поле не видно на скріні — постав null.",
  input_schema: {
    type: "object",
    properties: {
      views: { type: ["number", "null"] },
      reach: { type: ["number", "null"] },
      impressions: { type: ["number", "null"] },
      likes: { type: ["number", "null"] },
      comments: { type: ["number", "null"] },
      shares: { type: ["number", "null"] },
      saves: { type: ["number", "null"] },
    },
    required: ["views", "reach", "impressions", "likes", "comments", "shares", "saves"],
  },
};

async function extractMetrics(imageBase64, mediaType) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: "Витягни всі видимі метрики з цього скриншота статистики поста." },
        ],
      },
    ],
    tools: [metricsExtractionTool],
    tool_choice: { type: "tool", name: "extract_metrics" },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  return toolUse.input;
}

async function generateNarrative(campaignId, posts, summary) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    system: `Ти готуєш короткий звіт для бренду за результатами інфлюенсер-кампанії.
Пиши стисло, по суті: топ-перформери, аномалії, і 1-2 рекомендації. Без води.`,
    messages: [
      {
        role: "user",
        content: `Кампанія: ${campaignId}
Загальні перегляди: ${summary.totalViews}
Загальне охоплення: ${summary.totalReach}
Середній ER: ${(summary.averageEngagementRate * 100).toFixed(2)}%

По постах:
${posts
  .map((p) => `${p.creatorName} (${p.platform}): ${p.views ?? "?"} переглядів, ${p.likes ?? "?"} лайків`)
  .join("\n")}`,
      },
    ],
  });

  return response.content.find((b) => b.type === "text")?.text ?? "";
}

export { extractMetrics, generateNarrative };
