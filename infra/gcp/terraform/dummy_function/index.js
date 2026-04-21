const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

app.all('/*', (req, res) => {
  res.status(200).send('Initial setup function, please run CiCD...or function not implemented deploy cidi');
});

app.listen(port, () => {
  console.log(`Dummy function listening on port ${port}`);
});

exports.sendEmailFromOutbox = app;
exports.getUsageSnapshot = app;
exports.expandTemplatesInRange = app;
exports.postPlannedInstance = app;
exports.exportOrgData = app;
exports.importOrgData = app;
exports.wipeOrgData = app;
exports.getAnalyticsData = app;