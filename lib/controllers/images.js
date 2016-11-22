'use strict';
const plugins = require('../../plugins');
const config = require('../config');
const es = require('../services/elasticsearch');
const Q = require('q');
const fs = require('fs');
const path = require('path');
const waterStream = require('water-stream');
const google = require('../services/google');

var imageController = plugins.getFirst('image-controller');
if(!imageController) {
  throw new Error('Expected at least one image controller!');
}

const POSSIBLE_SIZES = config.thumbnailSizes;
const THUMBNAIL_SIZE = 350;
const STORAGE_DOWNLOAD_BASE_URL = 'https://storage.googleapis.com';

// Looping through the licenses to find the on
const WATERMARKED_LICENSE_IDS = config.licenseMapping
.map((license, licenseId) => {
  return {
    id: licenseId,
    watermark: license && license.watermark
  };
})
.filter(license => license.watermark)
.map(license => license.id);

var WATERMARK_BUFFERS = {};
Object.keys(config.watermarks || {}).forEach((catalog) => {
  var path = config.watermarks[catalog];
  WATERMARK_BUFFERS[catalog] = fs.readFileSync(path);
});

var FALLBACK_PATH = path.normalize(config.appDir + '/images/fallback.png');

const contentDispositionRegexp = /.*\.([^.]+)$/i;

exports.download = function(req, res, next) {
  var collection = req.params.collection;
  var id = req.params.id;
  var size = req.params.size;

  var params = {};
  if (size && POSSIBLE_SIZES && POSSIBLE_SIZES.indexOf(size) === -1) {
    throw new Error('The size is required and must be one of ' +
                    POSSIBLE_SIZES +
                    ' given: "' + size + '"');
  }

  var proxyRequest = imageController.proxyDownload(collection + '/' + id, size);

  res._writeHead = res.writeHead;
  res.writeHead = function(statusCode, reasonPhrase, headers) {
    if(statusCode === 200 && proxyRequest.response) {
      // Reading the file extension from the response from CIP
      var resHeaders = proxyRequest.response.headers || {};
      var contentDisposition = resHeaders['content-disposition'] || '';
      // Determine the file extension extension
      if(contentDisposition) {
        var parts = contentDisposition.match(contentDispositionRegexp);
        var extension;
        if(parts) {
          extension = '.' + parts[1];
        } else {
          extension = '.jpg'; // Default: When the CIP is not responsing
        }
        // Build the filename
        var filename = collection + '-' + id;
        if(size) {
          // Remove JPEG from e.g. kbh-museum-26893-originalJPEG.jpg
          filename += '-' + size.replace('JPEG', '');
        }
        // Generating a new filename adding size if it exists
        filename += extension;
        // Write the header
        res.set('content-disposition', 'attachment; filename=' + filename);
      }
    }
    res._writeHead(statusCode, reasonPhrase, headers);
  };

  proxyRequest
  .on('error', next)
  .on('response', function(response) {
    if(response.statusCode === 200) {
      proxyRequest.pipe(res);
    } else {
      res.type('png');
      getErrorPlaceholderStream().pipe(res);
    }
  });
};

const POSITION_FUNCTIONS = {
  'middle-center': waterStream.middleCenterPosition,
  'bottom-right': waterStream.bottomRightPosition
};

function getErrorPlaceholderStream() {
  return fs.createReadStream(FALLBACK_PATH);
}

function getThumbnail(collection, id, size, position) {
  // Let's find out what the license on the asset is
  return es.getSource({
    index: config.types.asset.index,
    type: 'asset',
    id: collection + '-' + id
  })
  .then(function(metadata) {
    let deferred = Q.defer();
    var proxyReq = imageController.proxyThumbnail(collection + '/' + id);
    // Apply the watermark if the config's licenseMapping states it
    var doMark = !metadata.license ||
                 WATERMARKED_LICENSE_IDS.indexOf(metadata.license.id) > -1;
    // We should only apply the watermark when the size is large
    doMark = doMark && size > THUMBNAIL_SIZE && config.features.watermarks;
    var watermark = null;
    var positionFunction = null;
    if (doMark && collection in WATERMARK_BUFFERS) {
      watermark = WATERMARK_BUFFERS[collection];
      positionFunction = POSITION_FUNCTIONS[position];
    }

    proxyReq.on('error', (err) => {
      console.error(err);
      return getErrorPlaceholderStream();
    }).on('response', function(response) {
      if(response.statusCode === 200) {
        var t = waterStream.transformation(watermark, size, positionFunction);
        deferred.resolve(proxyReq.pipe(t));
      } else {
        deferred.reject(new Error('Got a non 200 status from the CIP'));
      }
    });

    return deferred.promise;
  });
}

exports.thumbnail = function(req, res, next) {
  var collection = req.params.collection;
  var id = req.params.id;
  var size = req.params.size ? parseInt(req.params.size, 10) : THUMBNAIL_SIZE;
  var position = req.params.position || 'middle-center';
  if(!(position in POSITION_FUNCTIONS)) {
    throw new Error('Unexpected position function: ' + position);
  }

  const cacheFileName = [collection, id, size, position].join('-') + '.jpg';

  let cacheFile;
  if(config.features.thumbnailCaching) {
    // Make sure we have a bucket set
    if(!config.cache.googleStorageBucket) {
      throw new Error('You need to specify a cache.googleStorageBucket');
    }
    // Try to read the
    let bucket = google.storage.bucket(config.cache.googleStorageBucket);
    let cacheFile = bucket.file(cacheFileName);
    cacheFile.exists().then(function(data) {
      var exists = data[0];
      if(exists) {
        // Redirect the user to the cached version of the image
        let publicUrl = [
          STORAGE_DOWNLOAD_BASE_URL,
          cacheFile.bucket.id,
          cacheFile.id
        ].join('/');
        res.redirect(publicUrl);
      } else {
        return getThumbnail(collection, id, size, position).then((stream) => {
          stream.pipe(res);
          stream.pipe(cacheFile.createWriteStream());
        });
      }
    }).then(null, next);
  } else {
    // Just pipe the thumbnail to the response
    getThumbnail(collection, id, size, position).then((stream) => {
      stream.pipe(res);
    }, (err) => {
      console.error(err);
      getErrorPlaceholderStream().pipe(res);
    }).then(null, next);
  }
};
