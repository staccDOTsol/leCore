fetch('/api/hello?name=zoo&n=21')
  .then((r) => r.json())
  .then((j) => { document.getElementById('out').textContent = JSON.stringify(j, null, 2); });
