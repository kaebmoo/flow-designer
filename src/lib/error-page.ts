export function renderErrorPage(): string {
  /*
   * Standalone HTML: this page renders when SSR itself failed, so the app stylesheet may not
   * load. It therefore declares its own minimal semantic tokens inline — values copied from
   * the Air Traffic Obsidian palette in `src/styles.css` — and draws only from them, so the
   * failure page speaks the same visual language as the app instead of flashing a white page
   * over a dark product.
   */
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>This page didn't load</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: dark;
        --background: oklch(0.19 0.03 254);
        --foreground: oklch(0.97 0.01 240);
        --muted-foreground: oklch(0.72 0.03 240);
        --primary: oklch(0.82 0.15 200);
        --primary-foreground: oklch(0.18 0.03 254);
        --card: oklch(0.22 0.03 254);
        --border: oklch(0.32 0.03 254);
      }
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: var(--background); color: var(--foreground); display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; background: var(--card); border: 1px solid var(--border); border-radius: 0.5rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: var(--muted-foreground); margin: 0 0 1.5rem; }
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: var(--primary); color: var(--primary-foreground); }
      .secondary { background: transparent; color: var(--foreground); border-color: var(--border); }
      :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>This page didn't load</h1>
      <p>Something went wrong on our end. You can try refreshing or head back home.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Try again</button>
        <a class="secondary" href="/">Go home</a>
      </div>
    </div>
  </body>
</html>`;
}
