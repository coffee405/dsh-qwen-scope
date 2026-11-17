// A development stand-in for the real @deepseek-ai/schemastery, so the plugin's own scripts can import lib/index.js
// without a dsh install. dsh ships the real one; the `Config` schema is only read by dsh, never by these scripts.
const field = () => {
    const make = () => field();
    return { default: make, volatile: make, describe: make, required: make };
};
export const z = { object: field, string: field, number: field, boolean: field, array: field, natural: field, record: field, union: field, literal: field };
export default z;
