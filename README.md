# Post → Report

A web tool I built to collect and verify the results of influencer campaigns.

The input is a creator's screenshot of post statistics. The output is the recognized metrics (views, reach, likes, comments, shares, saves), a campaign summary and a short written conclusion for the brand. Instead of retyping numbers into a spreadsheet, you upload the screenshot and the tool reads it.

## Validation layer

This is the key part. Anything that looks physically impossible is automatically held in a manual review queue, with an explanation of what raised the doubt:

- more likes than views
- engagement rate above 100%
- reach more than 20 times the follower count

Clean records pass straight through. A recognition error cannot slip into a brand report unnoticed.

## Two views of the data

- **By campaign**: total views, reach, average engagement rate and an AI-written conclusion (top performers, anomalies, recommendations).
- **By creator**: a profile across all campaigns, with the history of each post and its engagement rate. It shows who performs consistently, not just the result of a single collaboration.

## How it works

The tool runs on its own backend (Node.js + Claude Vision API) with persistent storage for screenshots and data. The creator profile is calculated with local arithmetic and no AI call, so it opens instantly and uses no API quota.

## Stack

- Node.js, Express
- Anthropic Claude Vision API
- Railway

## Author

Yurii Hunko, [hunkoyura.com](https://hunkoyura.com)
