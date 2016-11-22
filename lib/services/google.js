'use strict';

var config = require('../config');
const storage = require('@google-cloud/storage');

// TODO: Use another package to access google vision and translate:
// See: https://github.com/GoogleCloudPlatform/google-cloud-node/
const vision = require('node-cloud-vision-api');
const translate = require('google-translate')(config.googleAPIKey);

vision.init({
  auth: config.googleAPIKey
});

if(!config.googleProjectId) {
  throw new Error('You need to specify a googleProjectId');
}

module.exports = {
  vision: vision,
  translate: translate,
  storage: storage({
    projectId: config.googleProjectId
  })
};
