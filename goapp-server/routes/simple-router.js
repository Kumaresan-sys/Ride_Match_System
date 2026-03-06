class SimpleRouter {
  constructor() {
    this.routes = [];
  }

  register(method, pattern, handler) {
    this.routes.push({ method, pattern, handler });
  }

  async dispatch(ctx) {
    for (const route of this.routes) {
      if (route.method !== ctx.method) continue;
      const params = matchPath(route.pattern, ctx.path);
      if (!params) continue;
      ctx.pathParams = params;
      return route.handler(ctx);
    }
    return null;
  }
}

function matchPath(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = pathPart;
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
}

module.exports = SimpleRouter;
