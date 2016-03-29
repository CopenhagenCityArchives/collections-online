/*jshint multistr: true */

var querystring = require('querystring'),
    es = require('../services/elasticsearch'),
    config = require('../config/config');

var licenseMapping = require('../config/license-mapping.json');

const SITEMAP_ASSET_LIMIT = 3000;

// One sitemap.xml file for crawlers, which points to all our sub sitemaps
exports.index = function(req, res, next) {
  var host_base = req.headers["x-forwarded-host"] || req.get('host');

  var sitemap = '<?xml version="1.0" encoding="UTF-8"?>' +
                '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

  es.search({
      "index": config.esAssetsIndex,
      "body": {
        "size":0,
        "aggs" : {
          "searchable": {
            "filter": {
              "term": {
                "is_searchable": true
              }
            },
            "aggs": {
              "catalogs" : {
                "terms" : { "field" : "catalog" }
              }
            }
          }
        }
      }
  }).then(function(response){
    var catalog_buckets = response.aggregations.searchable.catalogs.buckets;
    for (var c in catalog_buckets) {
      var catalog = catalog_buckets[c];
      var number_of_sitemaps = Math.ceil(catalog.doc_count / SITEMAP_ASSET_LIMIT);

      for (var i=0; i < number_of_sitemaps; i++){
        var baseUrl = 'http://' + host_base + '/';
        var sitemapPath = catalog.key.toUpperCase() + '/sitemap.xml?offset=' + i;

        sitemap += '<sitemap><loc>' + baseUrl + sitemapPath + '</loc></sitemap>';
      }

    }

    sitemap += '</sitemapindex>';

    res.header('Content-type', 'text/xml; charset=utf-8');
    res.send(sitemap);
  }, next);
};

exports.catalog = function(req, res, next) {
    var host_base = req.headers["x-forwarded-host"] || req.get('host');
    var catalog = req.params.catalog;
    var offset = parseInt(req.query.offset, 10) || 0;

    if (!catalog) {
      throw new Error('No catalog specified');
    }

    var parameters = {
        "index": config.esAssetsIndex,
        "size": SITEMAP_ASSET_LIMIT,
        "from": offset * SITEMAP_ASSET_LIMIT,
        "body": {
          "sort": [
            {"id": "asc"}
          ]
        }
    };

    parameters.body.filter = {
        "and": []
    };

    parameters.body.filter.and.push({
      "query": {
          "match": {
              "catalog": catalog
          }
      }
    });

    parameters.body.filter.and.push({
      "query": {
        "match": {
          "is_searchable": true
        }
      }
    });

    es.search(parameters).then(function(result) {
        var sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n \
                    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n \
                            xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"\n \
                            xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n';

        for (var i=0; i < result.hits.hits.length; ++i) {
            var source = result.hits.hits[i]._source;
            var catalog = source.catalog;
            var title = source.short_title || '';
            var description = source.description || '';
            var id = source.id;
            var license_url = '';

            if (source.license) {
                var license_id = source.license.id;
                var license_item = licenseMapping[license_id];
                license_url = license_item !== null && typeof license_item !== 'undefined' ? license_item.url : '';
            }

            var url = 'http://' + host_base + '/' + catalog + '/' + id;

            // YYYY-MM-DD
            var lastmod = new Date(source.modification_time).toISOString();

            var entry = '<url>\n \
                <loc>' + url + '</loc>\n \
                <changefreq>weekly</changefreq>\n \
                <lastmod>' + lastmod + '</lastmod>\n \
                <image:image>\n \
                  <image:loc>' + url + '/image/1200</image:loc>\n \
                  <image:title><![CDATA[' + title + ']]></image:title> \n \
                  <image:caption><![CDATA[' + description + ']]></image:caption> \n \
                  <image:license>' + license_url + '</image:license> \n \
                </image:image>\n \
            </url>\n';

            sitemap += entry;
        }

        sitemap += '</urlset>';
        res.header('Content-type', 'text/xml; charset=utf-8');
        res.send(sitemap);
    }, next);
};