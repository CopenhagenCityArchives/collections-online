const Auth0Strategy = require('passport-auth0');
const AuthenticationClient = require('auth0').AuthenticationClient;
const ManagementClient = require('auth0').ManagementClient;

const assert = require('assert');
const config = require('../config');

const domain = config.auth0 && config.auth0.domain;
const clientID = config.auth0 && config.auth0.clientID;
const callbackURL = config.auth0 && config.auth0.callbackURL;
const clientSecret = process.env.AUTH0_CLIENT_SECRET;

assert.ok(domain, 'Missing a config.auth0.domain');
assert.ok(clientID, 'Missing a config.auth0.clientID');
assert.ok(callbackURL, 'Missing a config.auth0.callbackURL');
assert.ok(clientSecret, 'Missing a AUTH0_CLIENT_SECRET environment variable');

const Auth = new AuthenticationClient({
  domain,
  clientId: clientID,
  clientSecret
});

let Service;

async function initService() {
  try {
    const {access_token} = await Auth.clientCredentialsGrant({
      audience: `https://${domain}/api/v2/`,
      scope: 'read:users'
    });


    console.log(`Retrieved Auth0 Token: ${access_token.substring(0, 10)} ...`);

    Service = new ManagementClient({
      token: access_token,
      domain
    });

    console.log('Auth0 Service initiated.');
  }

  catch(err) {
    console.log('We did not recieve an Auth0 Management Token:' + err.message);
  }
}

initService();

const strategy = new Auth0Strategy({
  domain, clientID, clientSecret, callbackURL
}, function(accessToken, refreshToken, extraParams, profile, done) {
  // accessToken is the token to call Auth0 API (not needed in the most cases)
  // extraParams.id_token has the JSON Web Token
  // profile has all the information from the user
  return done(null, profile);
});

module.exports = {
  Auth,
  Service,
  strategy
};
