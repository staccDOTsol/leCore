// Ineligible on purpose: fetch() reaches the network, which an instruction cannot do.
export default async function handler(req, res) {
  const r = await fetch('https://example.com/api');
  res.json(await r.json());
}
