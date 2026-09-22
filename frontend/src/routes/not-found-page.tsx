import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <section id="not-found-section" className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">The requested route does not exist.</p>
      <Link to="/" className="underline underline-offset-4">
        Return home
      </Link>
    </section>
  );
}
