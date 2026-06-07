function isGraphqlNameStart(value) {
  return /^[A-Za-z_]$/.test(value);
}

function isGraphqlNameContinue(value) {
  return /^[A-Za-z0-9_]$/.test(value);
}

function skipGraphqlString(source, index) {
  if (source.startsWith('"""', index)) {
    const end = source.indexOf('"""', index + 3);
    return end === -1 ? source.length : end + 3;
  }

  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
}

function skipGraphqlIgnored(source, index) {
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/.test(char) || char === ",") {
      cursor += 1;
      continue;
    }
    if (char === "#") {
      const newline = source.indexOf("\n", cursor + 1);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    return cursor;
  }
  return cursor;
}

function readGraphqlName(source, index) {
  if (!isGraphqlNameStart(source[index] ?? "")) {
    return undefined;
  }
  let cursor = index + 1;
  while (cursor < source.length && isGraphqlNameContinue(source[cursor])) {
    cursor += 1;
  }
  return { name: source.slice(index, cursor), end: cursor };
}

function skipGraphqlSelection(source, index) {
  let cursor = index;
  let depth = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "#") {
      const newline = source.indexOf("\n", cursor + 1);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === '"') {
      cursor = skipGraphqlString(source, cursor);
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth <= 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return cursor;
}

function skipGraphqlDefinition(source, index) {
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "#") {
      const newline = source.indexOf("\n", cursor + 1);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === '"') {
      cursor = skipGraphqlString(source, cursor);
      continue;
    }
    if (char === "{") {
      return skipGraphqlSelection(source, cursor);
    }
    cursor += 1;
  }
  return cursor;
}

function graphqlOperations(source) {
  const operations = [];
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipGraphqlIgnored(source, cursor);
    if (cursor >= source.length) {
      break;
    }
    if (source[cursor] === "{") {
      operations.push({ type: "query" });
      cursor = skipGraphqlSelection(source, cursor);
      continue;
    }

    const keyword = readGraphqlName(source, cursor);
    if (!keyword) {
      return undefined;
    }
    cursor = keyword.end;
    if (
      keyword.name === "query" ||
      keyword.name === "mutation" ||
      keyword.name === "subscription"
    ) {
      cursor = skipGraphqlIgnored(source, cursor);
      const operationName = readGraphqlName(source, cursor);
      if (operationName) {
        cursor = operationName.end;
      }
      operations.push({
        type: keyword.name,
        ...(operationName ? { name: operationName.name } : {}),
      });
      cursor = skipGraphqlDefinition(source, cursor);
      continue;
    }
    if (keyword.name === "fragment") {
      cursor = skipGraphqlDefinition(source, cursor);
      continue;
    }
    return undefined;
  }
  return operations;
}

function graphqlAccessFromQuery(query, operationName) {
  const operations = graphqlOperations(query);
  if (!operations || operations.length === 0) {
    return "write";
  }
  const selected = operationName
    ? operations.find((operation) => operation.name === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!selected) {
    return "write";
  }
  return selected.type === "mutation" ? "write" : "read";
}

/** Classify a GitHub GraphQL JSON request body as read or write access. */
export function graphqlAccessFromBody(body) {
  if (!body) {
    return "write";
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "write";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "write";
  }
  const query = typeof parsed.query === "string" ? parsed.query : undefined;
  if (!query?.trim()) {
    return "write";
  }
  const operationName =
    typeof parsed.operationName === "string" && parsed.operationName.trim()
      ? parsed.operationName.trim()
      : undefined;
  return graphqlAccessFromQuery(query, operationName);
}
