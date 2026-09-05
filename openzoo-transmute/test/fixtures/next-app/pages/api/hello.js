// pages/api: query echo, a default, Number math, a module helper and an array callback.
const GREETINGS = { en: 'hello', fr: 'bonjour' };

function pick(lang) {
  return GREETINGS[lang] || GREETINGS.en;
}

export default function handler(req, res) {
  const { name = 'world', n, lang } = req.query;
  const doubled = Number(n) * 2;
  const words = [name, 'from', 'zoo'].map((w) => w.toUpperCase());
  let total = 0;
  words.forEach((w) => { total += w.length; });
  res.status(200).json({
    hello: name,
    n: Number.isNaN(doubled) ? null : doubled,
    greeting: `${pick(lang)} ${name}!`,
    shout: words.join(' '),
    letters: total,
    method: req.method,
    count: words.length,
  });
}
