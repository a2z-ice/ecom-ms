import { UserManager, WebStorageStateStore } from 'oidc-client-ts'

// All config from Vite env vars (injected at build time via ConfigMap in k8s)
const AUTHORITY = import.meta.env.VITE_KEYCLOAK_AUTHORITY   // e.g. http://idp.keycloak.net:30000/realms/bookstore
const CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID   // ui-client
const REDIRECT_URI = import.meta.env.VITE_REDIRECT_URI      // http://localhost:30000/callback

export const userManager = new UserManager({
  authority: AUTHORITY,
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: 'openid profile email roles',

  // PKCE is enabled by default in oidc-client-ts when response_type is 'code'

  // Tokens in sessionStorage — cleared on tab close (never localStorage)
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),

  // Silent token refresh via hidden iframe
  automaticSilentRenew: true,
  silent_redirect_uri: `${window.location.origin}/silent-renew.html`,

  // Load user info from ID token claims (not userinfo endpoint)
  loadUserInfo: false,
})
