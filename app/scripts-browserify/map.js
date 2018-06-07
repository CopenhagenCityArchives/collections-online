/**
 * The Map "Controller" that wraps a Google Maps and integrates it with searches.
 *
 * The controller is initialized via init() after which calls to update() is
 * used to load the map with data.
 *
 * The map will used hashed search-results (provided via update()) at wide
 * zoom levels, and detailed asset search-results when zoomed in closer.
 *
 * The controller users markerclusterer.js to cluster search-results that are
 * in proximity. For hash-based results this will be rather few points (as a
 * hash result already represents a cluster), in this situation the clusterer
 * counts not the number of points, but the number of points represented by each
 * hash-result and will thus appear much like if the map actually contained the
 * number of points represented by each hash result.
 *
 * When the user intacts with the map all points are cleared. The map is re-
 * populated when the user lets go of the map and it becomes idle (see the idle-
 * event-handler registered in init().
 */
var Map = {
  // Start the map off over Copenhagen.
  mapCenter: {
    lat: 55.6761,
    lng: 12.5683
  },
  mapZoomLevel: 12,

  // Reference to the google.maps.Map instance created in init().
  googleMap: false,

  // Whether the map is initializing and searches should not be triggered.
  isInitializing: true,

  // Whether the user is interacting with the map.
  mapInMotion: false,

  // Reference to current set of markers.
  clusteredMarkers: false,

  config: {
    // The zoom level where we start showing assets instead of hashed buckets.
    assetZoomLevel: undefined,
    // The max zoom level we're going to show clusters.
    clusterMaxZoom: undefined,
    // The callback to search/index.js we use when the map changes.
    updateCallback: undefined
  },

  /**
   * Returns an Elastic Search {top_left, bottom_right} bounds object.
   */
  getEsBounds: function() {
    if (this.googleMap && this.googleMap.getBounds()) {
      let ne = this.googleMap.getBounds().getNorthEast();
      let sw = this.googleMap.getBounds().getSouthWest();

      // Google maps gives us NE/SW coordinate, Elasticsearch wants a NW/SE, so
      // we have to reorder the coordinates before using them.
      return {
        'top_left': {
          'lat': ne.lat(),
          'lon': sw.lng()
        },
        'bottom_right': {
          'lat': sw.lat(),
          'lon': ne.lng()
        }
      };
    } else {
      return false;
    }
  },

  /**
   * Write the state of the map out into public properties.
   *
   * When used as a callback the map is passed in so that we use a correct
   * reference instead of this.
   */
  sync: function(updateSearch, map = this) {
    map.zoomLevel = map.googleMap.getZoom();
    map.center = map.googleMap.getCenter();
  },

  /**
   * Update an initialized map based on an array of search result items.
   *
   * The items must have one of the following structures
   *
   * {type: "hash", location: {lat: ..., lon: ...}, count: ...}
   *
   * {type: "asset", location: {lat: ..., lon: ...}, assetData: ....}
   *
   * @param items
   */
  update: function(items) {
    let iconPath = '../images/icons/map/';
    if (items.length === 0) {
      return;
    }

    let itemType = items[0].type;

    let markers = items.map(function(item) {
      if (!item.location || !item.location.lat || !item.location.lon) {
        // Skip items without location.
        return;
      }

      // Set the properties the markers share.
      let markerData = {
        position: {lat: item.location.lat, lng: item.location.lon}
      };

      // Hash markers are all going to be aggregated so all we need to inject
      // is a count.
      if(item.type === 'hash') {
        markerData.subCount = item.count;
      } else if (item.type === 'asset') {
        var colid = item.assetData.collection + '/' + item.assetData.id;
        var boxText = document.createElement('div');

        boxText.innerHTML = '<a href="/' + colid + '"><img data-src="/' + colid + '/thumbnail" width="220px" height="220px" /><h1>' + item.assetData.short_title + '</h1></a>';

        var infoboxConfiguration = {
          content: boxText,
          maxWidth: 220,
          zIndex: null,
          closeBoxURL: '',
          alignBottom: true,
          pixelOffset: new google.maps.Size(-110, -40),
        };

        markerData.title = item.assetData.short_title;
        markerData.icon = iconPath + 'pin.png';
        markerData.infobox = new InfoBox(infoboxConfiguration);
      }

      return new google.maps.Marker(markerData);
    });

    // Filter away markers without location.
    markers = markers.filter(Boolean);

    if (itemType === 'asset') {
      let googleMapReference = this.googleMap;
      markers.forEach(marker => {
        marker.addListener('mousedown', function() {
          // Close all markers and then add listener on marker, so all infoboxes are closed even if the map is updated.
          google.maps.event.trigger(googleMapReference, 'closeAllInfoboxes');
          google.maps.event.addListener(googleMapReference, 'closeAllInfoboxes', function () {
            marker.infobox.close();
          });

          marker.infobox.open(googleMapReference, marker);
          [].forEach.call(marker.infobox.content_.querySelectorAll('img[data-src]'), function(img) {
            img.setAttribute('src', img.getAttribute('data-src'));
            img.onload = function() {
              img.removeAttribute('data-src');
            };
          });
        });
      });
    }

    // Set up the icons for the clustering.
    // Only allow the clusterer to reval the individual markers if they are not
    // hashes.
    let textColor = '#E32166';
    let options = {
      minimumClusterSize: itemType === 'hash' ? 1 : 5,
      clickZoomLevel: itemType === 'hash' ? this.config.assetZoomLevel : -1,
      // How much a cluster takes up - this is what controls how large a cluster
      // is on the screen.
      gridSize: 55,
      // Zooming in further than this will disable clustering.
      maxZoom: this.config.clusterMaxZoom,
      styles: [
        {
          textColor: textColor,
          url: iconPath + 'm1.png',
          height: 48,
          width: 48
        },
        {
          textColor: textColor,
          url: iconPath + 'm2.png',
          height: 56,
          width: 56
        },
        {
          textColor: textColor,
          url: iconPath + 'm3.png',
          height: 64,
          width: 64
        },
      ],
    };


    let clusteredMarkers = new MarkerClusterer(this.googleMap, markers, options);
    // Have the clustermarkers remove themselves if the map is touched.
    google.maps.event.addListenerOnce(this.googleMap, 'bounds_changed', function() {
      google.maps.event.trigger(this.googleMap, 'closeAllInfoboxes');
      clusteredMarkers.clearMarkers();
    });
  },

  /**
   * Validate config and populate object properties
   *
   * @param initConfig
   *   A config object.
   * @returns Object
   *   The validated config optionally with defaults injected
   *
   * @private
   */
  _checkAndProcessConfig: function(initConfig) {
    // We do a somewhat strict validation because we're pretty sure which
    // parameters we're going to get in, and flexibility in this situation just
    // open us up for bugs.
    if (!initConfig.updateCallback) {
      throw new Error('Could not initialize map controller, missing updateCallback');
    }
    this.config.updateCallback = initConfig.updateCallback;

    if (initConfig.assetZoomLevel === undefined) {
      throw new Error('Could not initialize map controller, missing missing assetZoomLevel');
    }
    this.config.assetZoomLevel = initConfig.assetZoomLevel;

    if (initConfig.clusterMaxZoom === undefined) {
      throw new Error('Could not initialize map controller, missing missing clusterMaxZoom');
    }
    this.config.clusterMaxZoom = initConfig.clusterMaxZoom;

    // Read in some optional configurations.
    if (initConfig.center !== undefined) {
      this.center = initConfig.center;
    }

    if (initConfig.zoomLevel !== undefined) {
      this.zoomLevel = initConfig.zoomLevel;
    }
  },

  init: function (initConfig) {
    // Validate config and initialize som this.* properties if available.
    this._checkAndProcessConfig(initConfig);

    this.googleMap = new google.maps.Map(document.getElementById('map'), {
      // Center the map on copenhagen.
      center: this.mapCenter,
      zoom: this.mapZoomLevel,
      // Don't require the user to use two fingers when scrolling.
      gestureHandling: 'greedy'
    });

    // Setup variables for the closures below.
    let thisReference = this;

    // If any changes is made to the viewport of the map, mark it as in motion.
    google.maps.event.addListener(this.googleMap, 'bounds_changed', function() {
      // Only act on change events if the map was previously reported idle.
      if (!thisReference.mapInMotion) {
        // Report the map as being non-idle.
        thisReference.mapInMotion = true;
      }
    });

    // When the map stops moving, sync the state out into our own properties and
    // trigger a new search.
    google.maps.event.addListener(this.googleMap, 'idle', function(){
      // The initialization of the map will throw off a single idle event, so
      // ignore it and clear the initializing flag.
      if (thisReference.isInitializing) {
        thisReference.isInitializing = false;
        thisReference.mapInMotion = false;
        return;
      }
      // The map has settled down and we're ready to react on new changes.
      if (thisReference.mapInMotion) {
        thisReference.mapInMotion = false;
        thisReference.sync();
        thisReference.config.updateCallback(true, true);
      }
    });

    // TODO - make this work - KB-354.
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function(position) {
        var currentLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        let iconPath = '../images/icons/map/';
        var currentLocationMarker = new google.maps.Marker({
          position: currentLocation,
          title: 'Din placering',
          animation: google.maps.Animation.DROP,
          icon: iconPath + 'currentLocation.png'
        });
        currentLocationMarker.setMap(this.googleMap);

        this.googleMap.setCenter(currentLocation);
      });
    }
  }
};

module.exports = Map;
