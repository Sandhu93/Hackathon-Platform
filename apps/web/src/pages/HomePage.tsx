import { Link } from 'react-router';

export function HomePage() {
  return (
    <section aria-labelledby="home-heading">
      <h1 id="home-heading">Hackathon Platform</h1>
      <p className="lead">
        Find teammates, form a team and submit your project for the organisation&apos;s hackathons.
      </p>
      <p>
        Event registration and teams are being built in the next milestones. You can sign in with
        your institutional email, and check that the service is running.
      </p>
      <p>
        <Link className="button" to="/status">
          Check system status
        </Link>
      </p>
    </section>
  );
}
