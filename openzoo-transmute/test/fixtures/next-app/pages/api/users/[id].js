// pages/api with a dynamic segment: req.query.id comes from the route, 404 branch, res.status chains.
const USERS = [
  { id: '7', name: 'Ada', role: 'admin' },
  { id: '42', name: 'Linus', role: 'user' },
];

export default async function handler(req, res) {
  const { id } = req.query;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const user = USERS.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ error: `user ${id} not found` });
  }
  const { role, ...publicUser } = user;
  res.status(200).json({ ...publicUser, isAdmin: role === 'admin' });
}
