import { createApp } from './app';

/** Worker entry point. Only `/api/*` reaches this Worker; static assets are served by the platform. */
export default createApp();
