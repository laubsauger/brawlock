# Google sign-in setup

This is the provider-console setup for the account slice in [ACCOUNTS.md](ACCOUNTS.md). The user approved the main game/auth origin `https://brawlock.osc.link`. These instructions do not deploy the account service or switch the live website.

Current progress, 2026-10-19: the Google web client is created, its downloaded JSON has been validated, and its secret/configuration are installed privately on the US account authority. The service and same-origin website/proxy still need the coordinated account rollout before a real login can be tested. Do not recreate the client or rotate its secret for an ordinary application update.

## 1. Select a project

Open [Google Cloud Console](https://console.cloud.google.com/), sign in, and use the project selector in the top bar. Create a project named **Brawlock**, or select the project's existing account application. Keep the project ID for operations; it is not a secret.

Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) with that project selected. For a new project, choose **Get started**.

## 2. App identity and audience

Set the app name to **Brawlock**. Choose a support email that the operator can monitor and provide the requested developer contact email. Choose **External** for the audience so players outside a Google Workspace organization can sign in. Complete Google's requested consent/confirmation fields and create the configuration.

For initial testing, keep the app in its testing state. On **Audience**, add the operator and collaborator as test users if the console requires a test-user list. Public launch is a later step after domain, home page and privacy information are ready.

On **Branding**, the home page will be `https://brawlock.osc.link`. Authorized domains use the registered domain **osc.link**, not a URL or the `brawlock` subdomain. Google's production brand verification can require proof of domain ownership through Search Console and a genuine privacy policy on the verified domain. Do not invent a policy URL or publish an inaccurate policy just to pass the form. An app logo is optional for the initial test setup.

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
