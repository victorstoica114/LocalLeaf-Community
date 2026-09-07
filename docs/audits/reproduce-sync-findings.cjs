/* The original audit probes are now regression tests integrated into npm test.
 * Run npm.cmd run compile first. This entry point keeps the audit command usable.
 */
require('../../out/test/syncAuditTest.js');
