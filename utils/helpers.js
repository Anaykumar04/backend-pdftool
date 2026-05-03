const getBaseUrl = (req) => {
  if (process.env.BASE_URL) return process.env.BASE_URL;

  // Always use https in production (Render terminates SSL at load balancer,
  // so req.protocol returns 'http' even though the public URL is https)
  if (process.env.NODE_ENV === 'production') {
    const host = req ? req.get('host') : 'backend-pdftool.onrender.com';
    return `https://${host}`;
  }

  const host = req ? req.get('host') : `localhost:${process.env.PORT || 5000}`;
  return `http://${host}`;
};

module.exports = { getBaseUrl };

