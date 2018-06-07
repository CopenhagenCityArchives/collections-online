const config = require('collections-online/shared/config');

/**
 * This module handles the rendering of the sorting
 */

var template = require('views/includes/search-results-sorting');

/**
 * Updates the search filter sidebar based on the selected and available filters
 */
exports.update = function(searchParams) {
    const $sortingMenu = $('#sorting-menu');
    // Render the markup

    const markup = template({
        sorting: searchParams.sorting,
        sortOptions: config.sortOptions
    });
    // Replace the HTML with the newly rendered markup
    $sortingMenu.html(markup);
};
