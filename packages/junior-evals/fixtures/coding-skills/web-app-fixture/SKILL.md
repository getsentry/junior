---
name: web-app-fixture
description: Use for work on the Sunny Cups web app checkout under skills/web-app-fixture/project.
---

# Sunny Cups Web App

The Sunny Cups web app is checked out at `skills/web-app-fixture/project`. It
is a static site: `index.html` and `styles.css`.

Inspect the relevant files before you change them. To check a UI change, start
the dev server from the project directory and open the page:

```sh
(setsid nohup python3 -m http.server 4173 --bind 0.0.0.0 > /tmp/web-app.log 2>&1 &)
curl -s -o /dev/null -w '%{http_code}' localhost:4173/
```

Report the files that you changed and what you checked.
