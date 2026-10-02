"""Search answers: answering a portal search when the search is a question.

A search is free text from a search box, so most are keywords, not questions.
Two filters decide whether to answer:

1. :func:`looks_like_question` — a cheap check that skips obvious keyword
   searches without a model call (switchable per chat app).
2. The agent itself, told by :data:`SEARCH_GUIDANCE` to open its reply with a
   marker: ``[NOT_A_QUESTION]`` (stay out of the way), ``[ANSWER]`` (only when
   the retrieved docs clearly answer it) or ``[CLARIFY]`` (otherwise: ask one
   follow-up question, optionally with a few options to pick from).

:func:`parse_reply` turns the marked reply into what the widget shows. Anything
the visitor types next is an ordinary chat turn in the same conversation.
"""

import re
from dataclasses import dataclass, field
from typing import List, Literal

Kind = Literal["answer", "clarify", "not_a_question"]

# Words that open a question (or a request for help) in a search box.
_QUESTION_OPENERS = {
    "how", "what", "why", "when", "where", "which", "who", "whom", "whose",
    "can", "could", "do", "does", "did", "is", "are", "was", "were", "should",
    "would", "will", "may", "might", "must", "has", "have", "am",
    "explain", "help", "troubleshoot", "fix", "compare", "difference",
    "i", "i'm", "im", "my", "we", "our",
}

MIN_WORDS_FOR_NATURAL_LANGUAGE = 5


def looks_like_question(query: str) -> bool:
    """Whether a search is worth a model call.

    True for a question mark, a question/help opener ("how do I…", "can I…",
    "my export fails…"), or five or more words (natural language rather than
    keywords). False for short keyword searches like "api tokens" or
    "release notes 4.2", where the results list is the answer.
    """
    text = " ".join((query or "").split())
    if not text:
        return False
    if "?" in text:
        return True
    words = re.findall(r"[\w']+", text.lower())
    if not words:
        return False
    if words[0] in _QUESTION_OPENERS:
        return True
    return len(words) >= MIN_WORDS_FOR_NATURAL_LANGUAGE


SEARCH_GUIDANCE = """## This conversation started from a documentation search

The visitor's first message is what they typed into the documentation portal's search box. Your reply is shown above their search results, so it must earn its place.

Begin your reply with exactly one of these markers on its own first line:

[NOT_A_QUESTION]
The search is keywords or a lookup (for example "api tokens" or "release notes 4.2"), where the search results are the best response. Write nothing after the marker, and decide this before using any tools.

[ANSWER]
You searched the documentation and opened topics that directly and unambiguously answer the question. Then give a concise answer — a few sentences or a short numbered list — and link the topics you used.

[CLARIFY]
It is a question, but you are not confident enough to answer: it is ambiguous (it could mean things the documentation treats differently — products, versions, roles, deployment types), or the topics you found do not clearly answer it. Ask one short follow-up question that would let you answer. If there are a few distinct possibilities, list them after the question as bullet lines starting with "- " (at most 4, a few words each) so the visitor can pick one.

When unsure between [ANSWER] and [CLARIFY], choose [CLARIFY]. Never answer from general knowledge. After this first reply, the conversation continues as a normal chat and the markers are no longer used."""

# At the start of any line: models sometimes put a stray sentence before it.
_MARKER = re.compile(r"^[ \t]*\[(ANSWER|CLARIFY|NOT_A_QUESTION)\][ \t]*\n?", re.IGNORECASE | re.MULTILINE)
_OPTION = re.compile(r"^\s*[-*•]\s+(.+?)\s*$")
MAX_OPTIONS = 4
MAX_OPTION_CHARS = 80


@dataclass
class SearchReply:
    kind: Kind
    content: str
    options: List[str] = field(default_factory=list)


def parse_reply(text: str) -> SearchReply:
    """Split a marked first reply into its kind, the text to show, and options.

    A reply without a marker is shown as an answer if it has any text, since
    the model plainly meant to say something; an empty one is treated as "not
    a question" so the widget stays hidden.
    """
    raw = text or ""
    match = _MARKER.search(raw)
    if match:
        kind = match.group(1).lower()
        body = raw[match.end():].strip()
    else:
        kind = "answer"
        body = raw.strip()

    if kind == "not_a_question" or not body:
        return SearchReply(kind="not_a_question", content="")

    if kind == "clarify":
        question_lines: List[str] = []
        options: List[str] = []
        for line in body.splitlines():
            option = _OPTION.match(line)
            if option and len(options) < MAX_OPTIONS:
                options.append(option.group(1).strip()[:MAX_OPTION_CHARS])
            elif not option:
                question_lines.append(line)
        question = "\n".join(question_lines).strip()
        if not question:  # only bullets: keep them as the text
            question = body
            options = []
        return SearchReply(kind="clarify", content=question, options=options)

    return SearchReply(kind="answer", content=body)
