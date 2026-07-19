// Application Default Credentials token source for the BigQuery runner.
// Isolated in its own file so the runner itself stays dependency-free and
// testable with an injected token provider.
import { GoogleAuth } from 'google-auth-library';
import type { AccessTokenProvider } from './bigquery.ts';

const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';

/**
 * Resolves credentials the standard GCP way: `gcloud auth
 * application-default login` locally, the attached service account in Cloud
 * Run. Nothing is read from the repo (GR-001).
 */
export class AdcTokenProvider implements AccessTokenProvider {
  readonly #auth: GoogleAuth;

  constructor(scopes: readonly string[] = [BIGQUERY_SCOPE]) {
    this.#auth = new GoogleAuth({ scopes: [...scopes] });
  }

  async getToken(): Promise<string> {
    const client = await this.#auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('no access token returned by ADC');
    return token;
  }

  /** The project ADC resolved to — handy for wiring, not used for authz. */
  async projectId(): Promise<string> {
    return this.#auth.getProjectId();
  }
}
