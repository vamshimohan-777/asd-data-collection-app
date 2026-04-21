const { getDefaultConfig: getExpoConfig } = require('expo/metro-config');
const { mergeConfig } = require('@react-native/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const expoConfig = getExpoConfig(__dirname);

const config = {};

module.exports = mergeConfig(expoConfig, config);

