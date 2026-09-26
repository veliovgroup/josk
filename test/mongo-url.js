export const getMongoDatabaseName = (mongoUrl) => {
  const schemeEnd = mongoUrl.indexOf('://');
  if (schemeEnd === -1) {
    return '';
  }

  const pathStart = mongoUrl.indexOf('/', schemeEnd + 3);
  if (pathStart === -1) {
    return '';
  }

  const queryStart = mongoUrl.indexOf('?', pathStart);
  const pathEnd = queryStart === -1 ? mongoUrl.length : queryStart;
  const pathname = mongoUrl.slice(pathStart + 1, pathEnd).replace(/\/$/, '');
  return decodeURIComponent(pathname);
};
