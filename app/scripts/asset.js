'use strict';

(function($, window) {
  var ACTION_ASSET_DOWNLOAD_SHOW = '[data-action="asset-download-show"]';
  var ACTION_BIG_IMAGE_TOGGLE = '[data-action="asset-image-size-toggle"]';
  var CONTENT_ASSET_DOWNLOAD = '[data-content="asset-download"]';
  var CONTENT_BIG_IMG_WRAP = '.image-wrapper';
  var CONTENT_BIG_IMG_CLASS = 'big-image';
  var CONTENT_SLIDER = '.slider';
  var OVERLAY_ACTIVE_CLASS = 'overlay__container--active';
  var OVERLAY_ANIM_IN_CLASS = 'overlay__container--anim-in';

  var AssetPage = {
    init: function() {
      $(ACTION_ASSET_DOWNLOAD_SHOW)
        .on('click', this.actionAssetDownloadShow.bind(this, true));
      $(CONTENT_ASSET_DOWNLOAD)
        .on('click', this.actionAssetDownloadShow.bind(this, false));
      $(CONTENT_BIG_IMG_WRAP)
        .on('click', this.toggleBigImage.bind(this));
      $(ACTION_BIG_IMAGE_TOGGLE)
        .on('click', this.toggleBigImage.bind(this));
      $(CONTENT_SLIDER).slick({
        lazyLoad: 'ondemand',
        infinite: true,
        speed: 300,
        slidesToShow: 4,
        slidesToScroll: 4,
        responsive: [{
          breakpoint: 768,
          settings: {
            slidesToShow: 3,
            slidesToScroll: 3,
          }
        }, {
          breakpoint: 480,
          settings: {
            slidesToShow: 2,
            slidesToScroll: 2
          }
        }]
      });
    },

    actionAssetDownloadShow: function(show) {
      var $el = $(CONTENT_ASSET_DOWNLOAD);
      if (show === true) {
        $el.addClass(OVERLAY_ACTIVE_CLASS);
        $el.addClass(OVERLAY_ANIM_IN_CLASS);
      } else if (show === false) {
        $el.removeClass(OVERLAY_ANIM_IN_CLASS);
        setTimeout(function() {
          $el.removeClass(OVERLAY_ACTIVE_CLASS);
        }, 300);
      }
    },

    toggleBigImage: function() {
      var $use = $(ACTION_BIG_IMAGE_TOGGLE).find('use');
      $(CONTENT_BIG_IMG_WRAP).closest('.container-fluid')
        .toggleClass(CONTENT_BIG_IMG_CLASS);
      if ($use.attr('xlink:href') === '#icon-zoom-in') {
        $use.attr('xlink:href', '#icon-zoom-out');
      } else {
        $use.attr('xlink:href', '#icon-zoom-in');
      }
    }
  };

  window.AssetPage = AssetPage;

})(jQuery, window);
