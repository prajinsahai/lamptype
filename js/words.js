/* =================================================================
   words.js - the word pool and text generation.

   Exposes TT.words.generate(count, { punctuation, numbers }) which
   returns an array of target words. Punctuation is applied as a
   second pass over the whole array so sentence casing flows across
   word boundaries instead of being decided per word in isolation.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  /* 200 common English words, in the tradition of typing tests.
     Words in everyday use are not anyone's property, and this selection
     is our own rather than copied from another project - which matters,
     because the obvious place to lift such a list from is GPL-licensed. */
  const WORDS = [
    'the', 'be', 'of', 'and', 'a', 'to', 'in', 'he', 'have', 'it',
    'that', 'for', 'they', 'i', 'with', 'as', 'not', 'on', 'she', 'at',
    'by', 'this', 'we', 'you', 'do', 'but', 'from', 'or', 'which', 'one',
    'would', 'all', 'will', 'there', 'say', 'who', 'make', 'when', 'can', 'more',
    'if', 'no', 'man', 'out', 'other', 'so', 'what', 'time', 'up', 'go',
    'about', 'than', 'into', 'could', 'state', 'only', 'new', 'year', 'some', 'take',
    'come', 'these', 'know', 'see', 'use', 'get', 'like', 'then', 'first', 'any',
    'work', 'now', 'may', 'such', 'give', 'over', 'think', 'most', 'even', 'find',
    'day', 'also', 'after', 'way', 'many', 'must', 'look', 'before', 'great', 'back',
    'through', 'long', 'where', 'much', 'should', 'well', 'people', 'down', 'own', 'just',
    'because', 'good', 'each', 'those', 'feel', 'seem', 'how', 'high', 'too', 'place',
    'little', 'world', 'very', 'still', 'nation', 'hand', 'old', 'life', 'tell', 'write',
    'become', 'here', 'show', 'house', 'both', 'between', 'need', 'mean', 'call', 'develop',
    'under', 'last', 'right', 'move', 'thing', 'general', 'school', 'never', 'same', 'another',
    'begin', 'while', 'number', 'part', 'turn', 'real', 'leave', 'might', 'want', 'point',
    'form', 'off', 'child', 'few', 'small', 'since', 'against', 'ask', 'late', 'home',
    'interest', 'large', 'person', 'end', 'open', 'public', 'follow', 'during', 'present', 'without',
    'again', 'hold', 'govern', 'around', 'possible', 'head', 'consider', 'word', 'program', 'problem',
    'however', 'lead', 'system', 'set', 'order', 'eye', 'plan', 'run', 'keep', 'face',
    'fact', 'group', 'play', 'stand', 'increase', 'early', 'course', 'change', 'help', 'line'
  ];

  const SENTENCE_ENDS = ['.', '.', '.', '.', '?', '!'];

  const randomInt = (max) => Math.floor(Math.random() * max);
  const pick = (arr) => arr[randomInt(arr.length)];

  function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  /* 1 to 4 digits, never with a leading zero. */
  function randomNumber() {
    const digits = 1 + randomInt(4);
    let out = String(1 + randomInt(9));
    for (let i = 1; i < digits; i++) out += randomInt(10);
    return out;
  }

  /* Mutates `list` in place: sentence casing, terminators, and the
     occasional comma, quote, bracket or possessive. */
  function punctuate(list) {
    let startOfSentence = true;

    for (let i = 0; i < list.length; i++) {
      let w = list[i];
      const isLast = i === list.length - 1;

      if (startOfSentence) {
        w = capitalize(w);
        startOfSentence = false;
      }

      if (isLast) {
        list[i] = w + pick(SENTENCE_ENDS);
        break;
      }

      const roll = Math.random();
      if (roll < 0.03) {
        w = '"' + w + '"';
      } else if (roll < 0.05) {
        w = '(' + w + ')';
      } else if (roll < 0.07) {
        w += ';';
      } else if (roll < 0.09) {
        w += ':';
      } else if (roll < 0.12) {
        w += "'s";
      } else if (roll < 0.22) {
        w += ',';
      } else if (roll < 0.35) {
        w += pick(SENTENCE_ENDS);
        startOfSentence = true;
      }

      list[i] = w;
    }

    return list;
  }

  /**
   * Build a list of target words.
   *
   * @param {number} count            how many words to produce
   * @param {object} [opts]
   * @param {boolean} [opts.punctuation]  add casing and punctuation
   * @param {boolean} [opts.numbers]      sprinkle in numeric tokens
   * @returns {string[]}
   */
  function generate(count, opts) {
    const options = opts || {};
    const total = Math.max(0, Math.floor(count) || 0);
    const list = [];
    let previous = '';

    for (let i = 0; i < total; i++) {
      if (options.numbers && Math.random() < 0.07) {
        list.push(randomNumber());
        previous = '';
        continue;
      }

      let word = pick(WORDS);
      if (word === previous) word = pick(WORDS); // one retry, avoids obvious repeats
      previous = word;
      list.push(word);
    }

    if (options.punctuation) punctuate(list);
    return list;
  }

  TT.words = { LIST: WORDS, generate, randomNumber, punctuate };
})(window.TT);
