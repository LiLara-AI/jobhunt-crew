'use strict';
const fs = require('fs');
const path = require('path');

const corpusPath = path.join(__dirname, 'corpus.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));

const morganVancePath = path.join(__dirname, '..', 'dossiers', 'morgan-vance.json');
const morganVance = JSON.parse(fs.readFileSync(morganVancePath, 'utf8'));

const alexRiveraPath = path.join(__dirname, '..', 'dossiers', 'alex-rivera.json');
const alexRivera = JSON.parse(fs.readFileSync(alexRiveraPath, 'utf8'));

const dossiers = {
  'morgan-vance': morganVance,
  'alex-rivera': alexRivera
};

module.exports = {
  corpus,
  dossiers,
  cleanCases: corpus.filter(c => c.type === 'clean'),
  fabricationCases: corpus.filter(c => c.type === 'fabrication')
};
