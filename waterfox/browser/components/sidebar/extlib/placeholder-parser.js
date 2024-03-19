/*
 license: The MIT License, Copyright (c) 2022 YUKI "Piro" Hiroshi
*/
'use strict';

export class PlaceHolderParserError extends Error {
  constructor(message, originalError) {
    super(message);
    this.originalError = originalError;
  }
}

export function process(input, processor, processedInput = '', logger = (() => {})) {
  let output = '';

  let lastToken = '';
  let inPlaceHolder = false;
  let inArgsPart = false;
  let inSingleQuoteString = false;
  let inDoubleQuoteString = false;
  let inBackQuoteString = false;
  let escaped = false;

  let name = '';
  let args = [];
  let rawArgs = '';

  for (const character of input) {
    processedInput += character;
    //console.log({input, character, lastToken, inPlaceHolder, inSingleQuoteString, inDoubleQuoteString, inArgsPart, escaped, output, name, rawArgs, args});

    if (escaped) {
      if ((inDoubleQuoteString && character == '"') ||
          (inSingleQuoteString && character == "'") ||
          (inBackQuoteString && character == '`')) {
        if (inArgsPart)
          rawArgs += '\\';
      }
      else if ((inDoubleQuoteString && character != '"') ||
               (inSingleQuoteString && character != "'") ||
               (inBackQuoteString && character != '`') ||
               (!inDoubleQuoteString &&
                !inSingleQuoteString &&
                !inBackQuoteString &&
                inArgsPart &&
                character != ')')) {
        if (inArgsPart)
          rawArgs += '\\';
        lastToken += '\\';
      }
      lastToken += character;
      if (inArgsPart)
        rawArgs += character;
      escaped = false;
      continue;
    }

    switch (character) {
      case '\\':
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (!escaped) {
          escaped = true;
          continue;
        }

        if (inArgsPart)
          rawArgs += character;

        lastToken += character;
        continue;

      case '%':
        if (!inPlaceHolder) {
          inPlaceHolder = true;
          output += lastToken;
          lastToken = '';
          continue;
        }

        if (inArgsPart)
          rawArgs += character;

        if (inSingleQuoteString ||
            inDoubleQuoteString ||
            inBackQuoteString ||
            inArgsPart) {
          lastToken += character;
          continue;
        }

        if (!name) {
          if (lastToken != '')
            name = lastToken;
          else
            throw new PlaceHolderParserError(`Missing placeholder name: ${processedInput}`);
        }

        inPlaceHolder = false;
        try {
          logger('parser: placeholder ', { name, rawArgs, args });
          output += processor(name, rawArgs, ...args);
        }
        catch(error) {
          throw new PlaceHolderParserError(`Unhandled error: ${error.message}\n${error.stack}`, error);
        }
        lastToken = '';
        name = '';
        args = [];
        rawArgs = '';
        continue;

      case '(':
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (inArgsPart)
          rawArgs += character;
        else if (rawArgs != '')
          rawArgs += ', ';

        if (inSingleQuoteString ||
            inDoubleQuoteString ||
            inBackQuoteString ||
            inArgsPart) {
          lastToken += character;
          continue;
        }

        inArgsPart = true;
        if (name == '' && lastToken != '')
          name = lastToken;
        lastToken = '';
        continue;

      case ')':
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (inSingleQuoteString ||
            inDoubleQuoteString ||
            inBackQuoteString ||
            !inArgsPart) {
          if (inArgsPart)
            rawArgs += character;
          lastToken += character;
          continue;
        }

        inArgsPart = false;
        if (rawArgs.trim() != '') {
          try {
            args.push(process(lastToken, processor, processedInput));
          }
          catch(error) {
            throw new PlaceHolderParserError(`Unhandled error: ${error.message}\n${error.stack}`, error);
          }
        }
        lastToken = '';
        continue;

      case ',':
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (inArgsPart)
          rawArgs += character;

        if (inSingleQuoteString ||
            inDoubleQuoteString ||
            inBackQuoteString ||
            !inArgsPart) {
          lastToken += character;
          continue;
        }

        try {
          args.push(process(lastToken, processor, processedInput));
        }
        catch(error) {
          throw new PlaceHolderParserError(`Unhandled error: ${error.message}\n${error.stack}`, error);
        }
        lastToken = '';
        continue;

      case '"':
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (inArgsPart)
          rawArgs += character;

        if (inSingleQuoteString ||
            inBackQuoteString) {
          lastToken += character;
          continue;
        }

        if (inDoubleQuoteString) {
          inDoubleQuoteString = false;
          continue;
        }

        inDoubleQuoteString = true;
        continue;

      case "'":
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (inArgsPart)
          rawArgs += character;

        if (inDoubleQuoteString ||
            inBackQuoteString) {
          lastToken += character;
          continue;
        }

        if (inSingleQuoteString) {
          inSingleQuoteString = false;
          continue;
        }

        inSingleQuoteString = true;
        continue;

      case '`':
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (inArgsPart)
          rawArgs += character;

        if (inDoubleQuoteString ||
            inSingleQuoteString) {
          lastToken += character;
          continue;
        }

        if (inBackQuoteString) {
          inBackQuoteString = false;
          continue;
        }

        inBackQuoteString = true;
        continue;

      default:
        if (!inPlaceHolder) {
          output += character;
          lastToken = '';
          continue;
        }

        if (inArgsPart)
          rawArgs += character;

        if (character.trim() == '') { // whitespace
          if (inSingleQuoteString ||
              inDoubleQuoteString ||
              inBackQuoteString ||
              !inArgsPart) {
            lastToken += character;
          }
        }
        else {
          lastToken += character;
        }
        continue;
    }
  }

  if (inPlaceHolder)
    throw new PlaceHolderParserError(`Unterminated placeholder: ${processedInput}`);

  if (inArgsPart)
    throw new PlaceHolderParserError(`Unterminated arguments for the placeholder "${name}": ${processedInput}`);

  if (inSingleQuoteString ||
      inDoubleQuoteString ||
      inBackQuoteString)
    throw new PlaceHolderParserError(`Unterminated string: ${processedInput}`);

  if (escaped)
    output += '\\';

  return output;
}
