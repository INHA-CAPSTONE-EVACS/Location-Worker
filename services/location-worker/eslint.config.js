'use strict';
const gts = require('gts');

module.exports = [
  {ignores: ['dist/', 'coverage/', 'node_modules/']},
  ...gts,
  {
    files: ['**/*.js'],
    languageOptions: {sourceType: 'commonjs'},
  },
];
