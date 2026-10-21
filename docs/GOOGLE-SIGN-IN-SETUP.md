# Google sign-in setup

This is the provider-console setup for the account slice in [ACCOUNTS.md](ACCOUNTS.md). The user approved the main game/auth origin `https://brawlock.osc.link`. These instructions do not deploy the account service or switch the live website.

Current progress, 2026-10-19: the Google web client, account service and same-origin website/proxy are deployed, and a real login has been confirmed by the user. The static `about.html`, `privacy.html`, `terms.html`, their shared stylesheet and the supplied ownership-verification file are live in the existing first-party web release `38a2f766fb5b`. HTTP/crawler checks confirmed exact built contents, including the Google file. The documents work without JavaScript and make no external requests. Menu, sign-in-dialog and Credits links are implemented locally for the next client release. Public pages and the Google file are retained by future first-party packages. Google Console ownership/branding approval is a separate operator step; uploading the verification file or a successful login does not establish that approval. Do not recreate the client or rotate its secret for an ordinary application update.

## 1. Select a project

Open [Google Cloud Console](https://console.cloud.google.com/), sign in, and use the project selector in the top bar. Create a project named **Brawlock**, or select the project's existing account application. Keep the project ID for operations; it is not a secret.

Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) with that project selected. For a new project, choose **Get started**.

## 2. App identity and audience

Set the app name to **Brawlock**. Choose a support email that the operator can monitor and provide the requested developer contact email. Choose **External** for the audience so players outside a Google Workspace organization can sign in. Complete Google's requested consent/confirmation fields and create the configuration.

On **Audience**, choose **External** and publish the application when ready. Google's documented exception for basic sign-in scopes (`openid email profile`) means players do not need to be on the test-user list even while the application is in Testing. Additional API scopes remove that exception. Publishing the audience and verifying/publishing the application's branding are separate steps.

On **Branding**, configure three distinct, public URLs:

| Google field | URL |
|---|---|
| Application homepage | `https://brawlock.osc.link/about.html` |
| Privacy policy | `https://brawlock.osc.link/privacy.html` |
| Terms of service | `https://brawlock.osc.link/terms.html` |

These are static documents without JavaScript, account checks, a canvas or the game's boot flow. The homepage describes Brawlock, its operator and sign-in use, links both policies and opens the game at its existing root URL. The policies identify **Promp' Industries** and link to the private contact form without publishing a mailbox address. Verify that the live documents match current practices whenever those change.

Authorized domains use the registered domain **osc.link**, not a URL or the `brawlock` subdomain. Google requires the verified owner to be associated with the OAuth project as an owner/editor. A domain that resolves and has HTTPS is not by itself proof of Google Search Console ownership.

The operator supplied the Search Console HTML verification file `googlec523c567482e96c5.html`. Its exact content is retained in `public/` and copied into first-party packages; `deploy/web.sh` permits it. It must remain publicly accessible at `https://brawlock.osc.link/googlec523c567482e96c5.html`, including after future releases. Uploading the file does not click Search Console's **Verify** button or prove Google's approval. Complete that step using the Google account associated with the OAuth project. The reported Google branding error instructs waiting 24 hours after ownership verification before retrying. Do not remove the file after success. If Google still requires ownership of the registered parent domain, verify the Domain property `osc.link` with the specific DNS record Search Console supplies; do not invent a verification token.

## 3. Create the web client

Open **Clients**, click **Create client**, select **Web application**, and name it **Brawlock Web**.

Enter this exact **Authorized redirect URI**:

```
https://brawlock.osc.link/api/auth/callback/google
```

This is the server-side OAuth callback, including its path and with no trailing slash. The library performs the redirect flow; JavaScript origins are not needed by this flow. If configuring a JavaScript origin as well, its value is only `https://brawlock.osc.link`, without a path. Do not substitute a region's hostname or the old GitHub Pages URL.

For a separate local test client, the documented development callback is `http://localhost:5189/api/auth/callback/google`, matching the local `AUTH_ORIGIN`. Prefer a separate test application when preparing production credentials.

Create the client and download its **JSON** while the secret is available. Store it outside this repository and send the assistant only its local file path. Do not paste or screenshot the client secret into chat. The JSON can be read locally to extract the public client ID and install the secret into a protected server-only file.

## 4. Scopes and launch

Brawlock's current Google authorization URL requests only `openid`, `email` and `profile`. It does not need Gmail, Drive, Calendar or other API permissions. On **Data Access**, keep the scope selection consistent with these basic identity fields.

Before launch: serve the game and auth endpoints on the approved HTTPS origin, configure and back up the account service, verify a real Google callback and logout, add a passkey and test a second browser, then complete Google's applicable branding/domain requirements and publish the audience configuration. Keep secrets out of the client build and Git. Accounts do not gate ranked until server-side regional admission and the separate fresh-season account ladder are ready.

Primary references checked 2026-10-19: [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid), [server-side OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [production policy compliance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance), and [Better Auth Google integration](https://better-auth.com/docs/authentication/google).
