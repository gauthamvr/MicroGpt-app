// https://docs.expo.dev/guides/using-eslint/
module.exports = {
  extends: ['expo', 'prettier', "eslint:recommended", "plugin:prettier/recommended"],
  plugins: ['prettier'],
  rules: {
    'prettier/prettier': 'error',
  },
};
