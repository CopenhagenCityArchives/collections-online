/**
 * This module handles all clientside searching
 */

const config = require('collections-online/shared/config');
const helpers = require('../../../shared/helpers');

const Map = require('../map');
require('./search-freetext-form');

const getSearchParams = require('./get-parameters');
const elasticsearchQueryBody = require('./es-query-body');
const elasticsearchAggregationsBody = require('./es-aggregations-body');
const generateQuerystring = require('./generate-querystring');
const resultsHeader = require('./results-header');
const sorting = require('./sorting');
const navigator = require('../document/navigator');
const geohash = require('./geohash');

const templates = {
  searchResultItem: require('views/includes/search-results-item')
};

// How many assets should be loaded at once?
const PAGE_SIZE = 24;
module.exports.PAGE_SIZE = PAGE_SIZE;

let resultsDesired = PAGE_SIZE;
let resultsLoaded = [];
let resultsTotal = Number.MAX_SAFE_INTEGER;
let loadingResults = false;

// Controls whether we should fetch search-results for a map or a list.
let viewMode = 'map';

let elasticsearch = require('elasticsearch');
let es = new elasticsearch.Client({
  host: location.origin + '/api'
});

// Expose setter for view-mode so that eg. view-mode.js can reach it.
let setViewMode = function(mode) {
  viewMode = mode;
};

module.exports.setViewMode = setViewMode;

function initialize() {
  const $searchInput = $('.search-freetext-form__input');
  const $results = $('#results');
  // Button shown at the end of the list search result that triggers the load
  // of more results.
  const $loadMoreBtn = $('#load-more-btn');
  const $noResultsText = $('#no-results-text');

  function reset() {
    resultsLoaded = [];
    resultsTotal = Number.MAX_SAFE_INTEGER;
    resultsDesired = PAGE_SIZE;
    $(window).off('scroll');
    $loadMoreBtn.addClass('invisible');
  }

  /**
   * Perform a search and update the map or list.
   *
   * @param updateWidgets
   *   Whether this update should trigger refresh of the related widgets.
   *
   * @param indicateLoading
   *   Whether to show a overlay as the results are loading.
   */
  function update(updateWidgets, indicateLoading) {
    // If the indicateLoading is not set - default to true
    if(typeof(indicateLoading) === 'undefined') {
      indicateLoading = true;
    }

    // Initialize search parameters from the url.
    var searchParams = getSearchParams();
    // Update the filter-bar.
    sorting.update(searchParams);

    // Update the freetext search input
    var queryString = searchParams.filters.q;
    $searchInput.val(queryString);

    // Update the page title
    const title = helpers.generateSearchTitle(searchParams.filters);
    $('head title').text(title + ' - ' + config.siteTitle);
    loadingResults = true;

    // A fresh update is the first of potentially many updates with the same
    // search parameters.
    updateWidgets = resultsLoaded.length === 0 || updateWidgets;

    if(updateWidgets) {
      resultsHeader.update(searchParams, resultsTotal);
      if(config.features.filterSidebar) {
        const sidebar = require('./filter-sidebar');
        // Update the sidebar right away
        sidebar.update(searchParams.filters, null);
        // Get aggragations for the sidebar
        es.search({
          body: elasticsearchAggregationsBody(searchParams),
          size: 0
        }).then(function (response) {
          sidebar.update(searchParams.filters, response.aggregations);
        }, function (error) {
          console.trace(error.message);
        });
      }
      // Update the results header before the result comes in
      if(indicateLoading) {
        $('.search-results').addClass('search-results--loading');
      }
    }


    let resultCallback = function (resultsTotal) {
      // Update the results header with the result
      if(updateWidgets) {
        resultsHeader.update(searchParams, resultsTotal);
        if(indicateLoading) {
          $('.search-results').removeClass('search-results--loading');
        }
      }
    };

    // Do search depending on current viewmode.
    if (viewMode === 'map') {
      resultsTotal = updateMap(searchParams, resultCallback);
    }

    if (viewMode === 'list') {
      resultsTotal = updateList(searchParams, updateWidgets, resultCallback);
    }
  }

  /**
   * Update the search result list.
   */
  function updateList(searchParams, updateWidgets, resultCallback) {
    // Generate the query body
    let queryBody = elasticsearchQueryBody(searchParams);

    if(typeof(helpers.modifySearchQueryBody) === 'function') {
      // If a modifySearchQueryBody helper is defined, call it
      queryBody = helpers.modifySearchQueryBody(queryBody, searchParams);
    }

    const searchObject = {
      body: queryBody,
      from: resultsLoaded.length,
      _source: ["collection", "id", "short_title", "type"],
      size: resultsDesired - resultsLoaded.length
    };

    // Pull in the search results.
    es.search(searchObject).then(function (response) {
      // If no results are loaded yet, it might be because we just called reset
      if(resultsLoaded.length === 0) {
        // Remove all search result items from $results, that might be there
        $results.find('.search-results-item').remove();
      }
      resultsTotal = response.hits.total;
      loadingResults = false;

      response.hits.hits.forEach(function(hit) {
        const item = {
          type: hit._type,
          metadata: hit._source
        };
        const markup = templates.searchResultItem(item);
        $results.append(markup);
        resultsLoaded.push(item);
      });

      // Save the results loaded in the session storage, so we can use them on
      // out other places.
      navigator.save({
        resultsLoaded, queryBody
      });

      // Replace the state of in the history if supported
      if(history.replaceState) {
        history.replaceState({
          resultsLoaded,
          resultsTotal
        }, null, null);
      }

      // Show some text if we don't have any results
      if (resultsTotal === 0) {
        $noResultsText.removeClass('hidden');
      } else {
        $noResultsText.addClass('hidden');
      }

      // If we have not loaded all available results, let's show the btn to load
      if(updateWidgets && resultsLoaded.length < resultsTotal) {
        $loadMoreBtn.removeClass('invisible');
      } else {
        $loadMoreBtn.addClass('invisible');
      }

      resultCallback(resultsTotal);
    }, function (error) {
      console.trace(error.message);
    });
  }

  /**
   * Update the google map with search results.
   */
  function updateMap(searchParams, resultCallback) {
    // Get bounds from map and use it.
    let bounds = Map.getEsBounds();
    if (bounds) {
      searchParams.filters.geobounds = bounds;
    }

    // Generate the query body, this will inject a bounds filter if we added
    // one above.
    let queryBody = elasticsearchQueryBody(searchParams);

    // Let plugins modify the search body.
    if(typeof(helpers.modifySearchQueryBody) === 'function') {
      // If a modifySearchQueryBody helper is defined, call it
      queryBody = helpers.modifySearchQueryBody(queryBody, searchParams);
    }

    let belowAssetZoomLevel = Map.zoomLevel >= config.search.assetZoomLevel;
    const maxAssets = config.search.maxAssetMarkers;

    // If we're zoomed in wide enough, use hash-based results.
    if (!belowAssetZoomLevel) {
      queryBody.aggregations = {
        "geohash_grid" : {
          "geohash_grid" : {
            "field" : "location",
            "precision" : config.search.geohashPrecision
          }
        }
      };
    }

    // We've configured our search, now setup the query and execute it.
    const searchObject = {
      body: queryBody,
      // We only want the aggregation so we don't care about the hits.
      size: belowAssetZoomLevel ? maxAssets : 0,
      _source: ["location", "longitude", "latitude", "collection", "id", "short_title", "type"],
    };

    es.search(searchObject).then(function (response) {
      resultsTotal = response.hits.total;
      loadingResults = false;

      let coordinates = [];
      // Convert the hits to items of different types depending on our zoom-
      // level.
      if (belowAssetZoomLevel) {
        // Asset hits contains a coordinate and metadata.
        response.hits.hits.forEach(function(hit) {
          coordinates.push({
            type: 'asset',
            // Pull lat/lon out into it's own property to allow us to share
            // code between hash and asset code.
            location: hit._source.location,
            assetData: hit._source,
          });
        });
      } else {
        response.aggregations.geohash_grid.buckets.forEach(function(hashBucket) {
          // Geohash hits contains a geocode we need to decode and a count.
          // No actual data about the assets.
          // Decode to {lat, lon}.
          let coordinate = geohash.decode(hashBucket.key);
          let count = hashBucket.doc_count;
          coordinates.push({
            type: 'hash',
            count: count,
            location: coordinate
          });
        });
      }
      Map.update(coordinates);
      // TODO - add navigator code like what we have in updateList to make
      // history work.

      resultCallback(resultsTotal);
    }, function (error) {
      console.trace(error.message);
    });
  }

  function changeSearchParams(searchParams) {
    // Change the URL
    if(history) {
      var qs = generateQuerystring(searchParams);
      reset();
      history.pushState({
        searchParams: searchParams
      }, '', location.pathname + qs);
      update();
    } else {
      throw new Error('History API is required');
    }
  }

  function enableEndlessScrolling() {
    $loadMoreBtn.addClass('invisible');
    $(window).on('scroll', function(e) {
      var $lastResult = $('#results .search-results-item:last-child');
      if($lastResult.length > 0) {
        var lastResultOffset = $lastResult.offset();
        var scrollTop = $(window).scrollTop();
        var scrollBottom = scrollTop + $(window).height();
        if(scrollBottom > lastResultOffset.top && !loadingResults) {
          console.log('Loading more results');
          resultsDesired += PAGE_SIZE;
          update();
        }
      }
    }).scroll();
  }

  function inflateHistoryState(state) {
    // Render results from the state
    if(state.resultsLoaded) {
      reset();
      // Remove all the search result items right away
      $results.find('.search-results-item').remove();

      // Append rendered markup, once per asset loaded from the state.
      resultsLoaded = state.resultsLoaded;
      resultsDesired = resultsLoaded.length;
      resultsLoaded.forEach(function(item) {
        var markup = templates.searchResultItem(item);
        $results.append(markup);
      });

      // Replace the resultsTotal from the state
      resultsTotal = state.resultsTotal;

      // Using the updateWidgets=true, updates the header as well
      // Using the indicateLoading=false makes sure the UI doesn't blink
      update(true, false);
    }
  }

  // When the user navigates the state, update it
  window.addEventListener('popstate', function(event) {
    inflateHistoryState(event.state);
  }, false);

  // Setup the map with a callback it can use when it needs a new search trigged
  // and a configuration for when we switch between hash and asset search-
  // results.
  Map.init({
    updateCallback: update,
    assetZoomLevel: config.search.assetZoomLevel,
    clusterMaxZoom: config.search.clusterMaxZoom
  });

  // Initialize the search results, either use the history state, or do an
  // update.
  if(!history.state) {
    update();
  } else {
    update();
    // TODO - make history work again. KB-354.
    // Temporarily disabled while we figure out how to store geohashes in the history.
    // inflateHistoryState(history.state);
  }

  // *** Register event handlers ***
  $('#sidebar, #sidebarmobile, #filters, #filtersmobile').on('click', '.btn', function() {
    var action = $(this).data('action');
    var field = $(this).data('field');
    var filter = config.search.filters[field];
    var value = $(this).data('value');
    if(!value && filter.type === 'date-interval-range') {
      var $form = $(this).closest('.form-group');
      var from = $form.find('[name='+field+'-from]').val() || '*';
      var to = $form.find('[name='+field+'-to]').val() || '*';
      if(from !== '*' || to !== '*') {
        value = from.replace(/-/g, '/') + '-' + to.replace(/-/g, '/');
      } else {
        return;
      }
    }
    var searchParams = getSearchParams();
    var filters = searchParams.filters;
    if(action === 'add-filter') {
      if(typeof(filters[field]) === 'object') {
        filters[field].push(value);
      } else {
        filters[field] = [value];
      }
      changeSearchParams(searchParams);
    } else if(action === 'remove-filter') {
      if(typeof(filters[field]) === 'object') {
        filters[field] = filters[field].filter(function(v) {
          return v !== value;
        });
      } else {
        delete filters[field];
      }
      changeSearchParams(searchParams);
    }
  });

  $('#sorting-menu').on('click', '.dropdown__options a', function() {
    var sorting = $(this).data('value');
    var searchParams = getSearchParams();
    searchParams.sorting = sorting;
    changeSearchParams(searchParams);
  });

  // Enabled the load-more button
  $loadMoreBtn.on('click', function() {
    enableEndlessScrolling();
  });

  // If the location hash is present, the results desired should reflect this
  // and endless scrolling should be enabled
  /*
  if(window.location.hash) {
    var referencedResult = parseInt(window.location.hash.substr(1), 10);
    resultsDesired = referencedResult + PAGE_SIZE;
    enableEndlessScrolling();
    // TODO: Scroll to the referenced result, when done loading
  }
  */

  // Toggle filtersection visibility on mobile
  $('#sidebar, #sidebarmobile').on('click', '[data-action="show-filters"]', function() {
    var filterSection = $(this).data('id') + '-filters';
    var $filterSection = $('[data-id="' + filterSection + '"]');
    var wasExpanded = $(this).hasClass('expanded');
    var visibleClass = 'search-filter-sidebar__filters--expanded';

    if (!wasExpanded) {
      $(this).addClass('expanded');
      $filterSection.addClass(visibleClass);
    } else {
      $(this).removeClass('expanded');
      $filterSection.removeClass(visibleClass);
    }
  });

  // Toggle filterbar menus
  $('.filterbar--mobile__button--filters').on('click', function() {
    $('body').addClass('has-filter-open');
  });

  $('.filterbar--mobile__button--close').on('click', function() {
    $('body').removeClass('has-filter-open');
  });

  $('.search-filter-sidebar__tab').on('click', '[data-action="show-filterbar-menu"]', function() {
    var wasExpanded = $(this).hasClass('expanded');
    var $parentItem = $(this).closest('.filterbar__item');
    var $filterbar = $(this).closest('.filterbar');

    $filterbar.find('.filterbar__menu').hide();
    $filterbar.find('.expanded').each(function() {
      $(this).removeClass('expanded');
    });

    if (!wasExpanded) {
      $(this).addClass('expanded');
      $parentItem.find('.filterbar__tab').addClass('expanded');
      $parentItem.find('.filterbar__menu').show();
    } else {
      $(this).removeClass('expanded');
      $parentItem.find('.filterbar__tab').removeClass('expanded');
      $parentItem.find('.filterbar__menu').hide();
    }
  });

  // Take control over the search form.
  $searchInput.closest('form').submit(function(e) {
    e.preventDefault();
    var queryString = $searchInput.val() || '';
    var searchParams = getSearchParams();
    searchParams.filters.q = queryString;
    changeSearchParams(searchParams);
  });
}

// If the path is right - let's initialize
if(decodeURIComponent(location.pathname) === '/' + config.search.path) {
  $(initialize);
}
