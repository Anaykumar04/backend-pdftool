const getBaseUrl = (req) => {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const host = req ? req.get('host') : `localhost:${process.env.PORT || 5000}`;
  const protocol = req ? req.protocol : 'http';
  
  // Default to pdftoolkit.com in production if no BASE_URL provided
  if (process.env.NODE_ENV === 'production' && !host.includes('localhost')) {
    return 'https://pdftoolkit.com';
  }
  return `${protocol}://${host}`;
};

module.exports = { getBaseUrl };
