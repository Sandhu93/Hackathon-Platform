import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section aria-labelledby="notfound-heading">
      <h1 id="notfound-heading">Page not found</h1>
      <p>The page you are looking for does not exist or has moved.</p>
      <p>
        <Link className="button" to="/">
          Go to the home page
        </Link>
      </p>
    </section>
  );
}
