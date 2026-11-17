// Functions offered in the formula editor: the XPath 3.1 functions integration work uses most,
// with a plain-language description. `insert` is what clicking one puts into the formula.

export interface FnInfo {
  name: string
  group: string
  signature: string
  description: string
  insert: string
}

const fn = (group: string, name: string, signature: string, description: string, insert?: string): FnInfo => ({
  group,
  name,
  signature,
  description,
  insert: insert ?? `${name}()`
})

export const FUNCTIONS: FnInfo[] = [
  fn('Text', 'concat', 'concat(a, b, …)', 'Joins values into one text.', 'concat(, )'),
  fn('Text', 'string-join', 'string-join(values, separator)', 'Joins a list of values with a separator.', "string-join(, ', ')"),
  fn('Text', 'upper-case', 'upper-case(text)', 'Converts to capital letters.'),
  fn('Text', 'lower-case', 'lower-case(text)', 'Converts to small letters.'),
  fn('Text', 'normalize-space', 'normalize-space(text)', 'Trims and collapses repeated spaces.'),
  fn('Text', 'substring', 'substring(text, start, length)', 'Part of a text; positions start at 1.', 'substring(, 1, 10)'),
  fn('Text', 'substring-before', 'substring-before(text, marker)', 'Text before the first occurrence of a marker.', "substring-before(, '-')"),
  fn('Text', 'substring-after', 'substring-after(text, marker)', 'Text after the first occurrence of a marker.', "substring-after(, '-')"),
  fn('Text', 'string-length', 'string-length(text)', 'Number of characters.'),
  fn('Text', 'contains', 'contains(text, part)', 'True when the text contains the part.', "contains(, '')"),
  fn('Text', 'starts-with', 'starts-with(text, prefix)', 'True when the text starts with the prefix.', "starts-with(, '')"),
  fn('Text', 'replace', 'replace(text, pattern, replacement)', 'Replaces every match of a regular expression.', "replace(, '', '')"),
  fn('Text', 'translate', 'translate(text, from, to)', 'Replaces characters one for one.', "translate(, '', '')"),
  fn('Text', 'tokenize', 'tokenize(text, pattern)', 'Splits text into a list.', "tokenize(, ',')"),
  fn('Text', 'string', 'string(value)', 'Converts any value to text.'),

  fn('Numbers', 'number', 'number(value)', 'Converts to a number (NaN if it is not one).'),
  fn('Numbers', 'round', 'round(number, digits)', 'Rounds; digits after the decimal point are optional.', 'round(, 2)'),
  fn('Numbers', 'floor', 'floor(number)', 'Rounds down.'),
  fn('Numbers', 'ceiling', 'ceiling(number)', 'Rounds up.'),
  fn('Numbers', 'abs', 'abs(number)', 'Absolute value.'),
  fn('Numbers', 'format-number', "format-number(number, '#,##0.00')", 'Formats a number as text.', "format-number(, '#,##0.00')"),
  fn('Numbers', 'sum', 'sum(values)', 'Adds up a list of numbers.'),
  fn('Numbers', 'avg', 'avg(values)', 'Average of a list of numbers.'),
  fn('Numbers', 'min', 'min(values)', 'Smallest value.'),
  fn('Numbers', 'max', 'max(values)', 'Largest value.'),

  fn('Dates', 'current-date', 'current-date()', "Today's date, like 2026-11-16."),
  fn('Dates', 'current-dateTime', 'current-dateTime()', 'Now, with time and time zone.'),
  fn('Dates', 'format-date', "format-date(xs:date(value), '[D01]/[M01]/[Y0001]')", 'Formats a date as text.', "format-date(xs:date(), '[D01]/[M01]/[Y0001]')"),
  fn('Dates', 'format-dateTime', "format-dateTime(xs:dateTime(value), '[Y0001]-[M01]-[D01] [H01]:[m01]')", 'Formats a date and time as text.', "format-dateTime(xs:dateTime(), '[Y0001]-[M01]-[D01] [H01]:[m01]')"),
  fn('Dates', 'xs:date', 'xs:date(text)', 'Reads text like 2026-11-16 as a date.'),
  fn('Dates', 'xs:dateTime', 'xs:dateTime(text)', 'Reads text like 2026-11-16T10:30:00 as a date and time.'),

  fn('Logic', 'if', "if (test) then a else b", 'Chooses between two values.', "if () then '' else ''"),
  fn('Logic', 'not', 'not(test)', 'True when the test is false.'),
  fn('Logic', 'exists', 'exists(value)', 'True when the value is present.'),
  fn('Logic', 'empty', 'empty(value)', 'True when the value is missing.'),
  fn('Logic', 'boolean', 'boolean(value)', 'Converts to true or false.'),

  fn('Lists', 'count', 'count(values)', 'How many items there are.'),
  fn('Lists', 'position', 'position()', 'Number of the current item inside a loop, starting at 1.'),
  fn('Lists', 'last', 'last()', 'How many items the current loop has.'),
  fn('Lists', 'distinct-values', 'distinct-values(values)', 'The values without duplicates.'),
  fn('Lists', 'head', 'head(values)', 'The first item.'),
  fn('Lists', 'reverse', 'reverse(values)', 'The items in reverse order.')
]

export const FUNCTION_GROUPS = [...new Set(FUNCTIONS.map((f) => f.group))]
