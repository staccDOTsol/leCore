// Vercel-node style (api/*.js, CommonJS): the cluster clock and the baked environment.
module.exports = (req, res) => {
  const now = Date.now();
  const iso = new Date().toISOString();
  const site = process.env.ZOO_NAME || 'unknown';
  const parts = [];
  for (const p of iso.split('T')) parts.push(p);
  res.setHeader('cache-control', 'no-store');
  res.json({ now, iso, site, date: parts[0], isNumber: typeof now === 'number', path: req.url });
};
