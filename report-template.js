// Renders a standalone, print-ready campaign report page.
// Charts are hand-rolled SVG on purpose: no CDN dependency, so the report
// prints correctly and still works offline or inside an email client.

const COLORS = {
  ink: "#16161a",
  dim: "#5f5f68",
  faint: "#9a9aa1",
  hair: "#e3e3e6",
  paper: "#ffffff",
  wash: "#f7f7f5",
  coral: "#d9564a",
  teal: "#2fa894",
  amber: "#c98a2e",
};

const PLATFORM_COLORS = {
  instagram: COLORS.coral,
  tiktok: COLORS.teal,
  youtube: COLORS.amber,
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(n) {
  if (n === null || n === undefined) return "—";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function pct(x, digits = 1) {
  return (x * 100).toFixed(digits) + "%";
}

// ---- Horizontal bar chart -------------------------------------------------

function hBarChart(rows, opts = {}) {
  const {
    width = 680,
    labelW = 150,
    rowH = 32,
    barH = 16,
    color = COLORS.teal,
    formatValue = num,
    avgLine = null,
    avgLabel = "",
  } = opts;

  if (!rows.length) return "";

  const valueW = 90;
  const trackX = labelW + 12;
  const trackW = width - trackX - valueW;
  // Scale to the largest value present, not to a fixed floor: with fractional
  // values (engagement rate) a floor of 1 would flatten every bar to a stub.
  const peak = Math.max(...rows.map((r) => r.value), avgLine ?? 0);
  const max = peak > 0 ? peak : 1;
  const height = rows.length * rowH + 16;

  const bars = rows
    .map((r, i) => {
      const y = i * rowH + 8;
      const w = Math.max((r.value / max) * trackW, r.value > 0 ? 2 : 0);
      const barColor = r.color || color;
      return `
        <text x="0" y="${y + barH / 2 + 4}" font-size="12" fill="${COLORS.ink}"
              font-family="Inter, sans-serif">${esc(r.label)}</text>
        <rect x="${trackX}" y="${y}" width="${trackW}" height="${barH}" rx="3" fill="${COLORS.wash}"/>
        <rect x="${trackX}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${barColor}"/>
        <text x="${trackX + trackW + 10}" y="${y + barH / 2 + 4}" font-size="12"
              fill="${COLORS.dim}" font-family="'JetBrains Mono', monospace">${formatValue(r.value)}</text>
      `;
    })
    .join("");

  let avg = "";
  if (avgLine !== null && avgLine > 0) {
    const x = trackX + (avgLine / max) * trackW;
    avg = `
      <line x1="${x}" y1="2" x2="${x}" y2="${rows.length * rowH + 4}"
            stroke="${COLORS.coral}" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${x + 5}" y="${rows.length * rowH + 14}" font-size="10" fill="${COLORS.coral}"
            font-family="'JetBrains Mono', monospace">${esc(avgLabel)}</text>
    `;
  }

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
               xmlns="http://www.w3.org/2000/svg" role="img">${bars}${avg}</svg>`;
}

// ---- Platform split (single stacked bar) ----------------------------------

function stackedBar(segments, opts = {}) {
  const { width = 680, height = 34 } = opts;
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) return "";

  let x = 0;
  const parts = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const w = (s.value / total) * width;
      const seg = `<rect x="${x}" y="0" width="${w}" height="${height}" fill="${s.color}"/>`;
      const label =
        w > 54
          ? `<text x="${x + 10}" y="${height / 2 + 4}" font-size="11" fill="#fff"
                   font-family="'JetBrains Mono', monospace">${esc(s.label)} ${pct(s.value / total, 0)}</text>`
          : "";
      x += w;
      return seg + label;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
               xmlns="http://www.w3.org/2000/svg" role="img">${parts}</svg>`;
}

// ---- Page -----------------------------------------------------------------

function renderReportHtml({ campaignId, posts, summary, narrative, generatedAt }) {
  // Group approved posts by creator
  const byCreatorMap = new Map();
  for (const p of posts) {
    if (!byCreatorMap.has(p.creatorId)) {
      byCreatorMap.set(p.creatorId, {
        creatorId: p.creatorId,
        creatorName: p.creatorName,
        platform: p.platform,
        posts: 0,
        views: 0,
        reach: 0,
        engagements: 0,
      });
    }
    const c = byCreatorMap.get(p.creatorId);
    c.posts += 1;
    c.views += p.views ?? 0;
    c.reach += p.reach ?? 0;
    c.engagements +=
      (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0);
  }
  const byCreator = [...byCreatorMap.values()]
    .map((c) => ({ ...c, er: c.reach > 0 ? c.engagements / c.reach : 0 }))
    .sort((a, b) => b.views - a.views);

  // Platform split by views
  const platMap = new Map();
  for (const p of posts) {
    platMap.set(p.platform, (platMap.get(p.platform) ?? 0) + (p.views ?? 0));
  }
  const platforms = [...platMap.entries()]
    .map(([label, value]) => ({
      label: label.toUpperCase(),
      value,
      color: PLATFORM_COLORS[label] || COLORS.faint,
    }))
    .sort((a, b) => b.value - a.value);

  // Date range
  const dates = posts.map((p) => p.postedAt).filter(Boolean).sort();
  const range = dates.length
    ? dates[0] === dates[dates.length - 1]
      ? dates[0]
      : `${dates[0]} — ${dates[dates.length - 1]}`
    : "—";

  const viewsChart = hBarChart(
    byCreator.map((c) => ({
      label: c.creatorName,
      value: c.views,
      color: PLATFORM_COLORS[c.platform] || COLORS.teal,
    })),
    { color: COLORS.teal }
  );

  const erChart = hBarChart(
    byCreator.map((c) => ({ label: c.creatorName, value: c.er })),
    {
      color: COLORS.coral,
      formatValue: (v) => pct(v),
      avgLine: summary.averageEngagementRate,
      avgLabel: "avg " + pct(summary.averageEngagementRate),
    }
  );

  const tableRows = byCreator
    .map(
      (c) => `
      <tr>
        <td class="name">${esc(c.creatorName)}</td>
        <td class="mono muted">${esc(c.platform)}</td>
        <td class="mono right">${c.posts}</td>
        <td class="mono right">${num(c.views)}</td>
        <td class="mono right">${num(c.reach)}</td>
        <td class="mono right">${num(c.engagements)}</td>
        <td class="mono right strong">${pct(c.er)}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(campaignId)} — Campaign Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: ${COLORS.ink};
    --dim: ${COLORS.dim};
    --faint: ${COLORS.faint};
    --hair: ${COLORS.hair};
    --wash: ${COLORS.wash};
    --coral: ${COLORS.coral};
    --teal: ${COLORS.teal};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--wash);
    color: var(--ink);
    font-family: 'Inter', -apple-system, sans-serif;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet {
    max-width: 820px;
    margin: 32px auto;
    background: #fff;
    padding: 56px 64px 64px;
    border: 1px solid var(--hair);
    border-radius: 4px;
  }
  .mono { font-family: 'JetBrains Mono', monospace; }

  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--coral);
    margin: 0 0 14px;
  }
  h1 {
    font-size: 34px;
    font-weight: 900;
    letter-spacing: -0.02em;
    margin: 0 0 10px;
    line-height: 1.1;
  }
  h1 .arrow { color: var(--teal); padding: 0 8px; }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 26px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--faint);
    margin: 0 0 40px;
    padding-bottom: 28px;
    border-bottom: 2px solid var(--ink);
  }
  .meta span { white-space: nowrap; }
  .meta b { color: var(--dim); font-weight: 500; }

  h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--dim);
    margin: 44px 0 18px;
    display: flex;
    align-items: center;
    gap: 9px;
  }
  h2::before {
    content: "";
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--coral);
  }

  .kpis {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--hair);
    border: 1px solid var(--hair);
  }
  .kpi { background: #fff; padding: 20px 18px; }
  .kpi .n {
    font-family: 'JetBrains Mono', monospace;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .kpi .l {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--faint);
    margin-top: 5px;
  }

  .legend {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--dim);
    margin-top: 12px;
  }
  .legend i {
    display: inline-block;
    width: 9px; height: 9px;
    border-radius: 2px;
    margin-right: 6px;
    vertical-align: -1px;
  }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--faint);
    font-weight: 500;
    padding: 0 10px 9px 0;
    border-bottom: 1px solid var(--hair);
  }
  td { padding: 11px 10px 11px 0; border-bottom: 1px solid var(--hair); }
  td.right, th.right { text-align: right; padding-right: 0; }
  td.name { font-weight: 600; }
  td.muted { color: var(--faint); }
  td.strong { color: var(--ink); font-weight: 600; }
  tr:last-child td { border-bottom: none; }

  .narrative {
    background: var(--wash);
    border-left: 3px solid var(--teal);
    padding: 22px 26px;
    font-size: 14px;
    color: var(--dim);
    line-height: 1.7;
    white-space: pre-wrap;
    border-radius: 0 6px 6px 0;
  }

  .foot {
    margin-top: 48px;
    padding-top: 20px;
    border-top: 1px solid var(--hair);
    font-family: 'JetBrains Mono', monospace;
    font-size: 10.5px;
    color: var(--faint);
    line-height: 1.7;
  }

  .toolbar {
    max-width: 820px;
    margin: 0 auto;
    padding: 20px 64px 0;
    text-align: right;
  }
  .print-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    padding: 10px 20px;
    border-radius: 7px;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: #fff;
    cursor: pointer;
  }

  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet {
      margin: 0;
      border: none;
      border-radius: 0;
      padding: 0;
      max-width: none;
    }
    h2 { break-after: avoid; }
    table, .narrative, .kpis { break-inside: avoid; }
  }
  @page { margin: 16mm; }
</style>
</head>
<body>

<div class="toolbar">
  <button class="print-btn" onclick="window.print()">Save as PDF</button>
</div>

<div class="sheet">
  <p class="eyebrow">INFLUENCE &amp; CONTENT OPS</p>
  <h1>Campaign <span class="arrow">→</span> Report</h1>
  <p class="meta">
    <span><b>Campaign</b> ${esc(campaignId)}</span>
    <span><b>Period</b> ${esc(range)}</span>
    <span><b>Creators</b> ${byCreator.length}</span>
    <span><b>Generated</b> ${esc(generatedAt)}</span>
  </p>

  <div class="kpis">
    <div class="kpi"><div class="n">${num(summary.postCount)}</div><div class="l">Posts</div></div>
    <div class="kpi"><div class="n">${num(summary.totalViews)}</div><div class="l">Views</div></div>
    <div class="kpi"><div class="n">${num(summary.totalReach)}</div><div class="l">Reach</div></div>
    <div class="kpi"><div class="n">${pct(summary.averageEngagementRate)}</div><div class="l">Avg ER</div></div>
  </div>

  <h2>Views by creator</h2>
  ${viewsChart || '<p class="mono" style="color:var(--faint);font-size:12px;">Немає даних.</p>'}
  <div class="legend">
    ${platforms
      .map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)}</span>`)
      .join("")}
  </div>

  <h2>Engagement rate by creator</h2>
  ${erChart || '<p class="mono" style="color:var(--faint);font-size:12px;">Немає даних.</p>'}

  <h2>Views split by platform</h2>
  ${stackedBar(platforms) || '<p class="mono" style="color:var(--faint);font-size:12px;">Немає даних.</p>'}

  <h2>Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Creator</th>
        <th>Platform</th>
        <th class="right">Posts</th>
        <th class="right">Views</th>
        <th class="right">Reach</th>
        <th class="right">Engagements</th>
        <th class="right">ER</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>

  <h2>Summary</h2>
  <div class="narrative">${esc(narrative)}</div>

  <p class="foot">
    Metrics were read from creator-supplied statistics screenshots and passed an
    automated plausibility check; flagged records were reviewed manually before
    inclusion. Reach-based engagement rate = (likes + comments + shares + saves) / reach.
    Posts still awaiting review are not included in this report.
  </p>
</div>

</body>
</html>`;
}

export { renderReportHtml };
