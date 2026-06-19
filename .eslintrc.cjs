/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ['@spark/config/eslint/base'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
}
