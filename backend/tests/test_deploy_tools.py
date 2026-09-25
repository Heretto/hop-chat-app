import asyncio
import json

import httpx
import pytest

from app.deploy.client import DeployClient, DeployConfig, DeployError
from app.deploy.tools import DeployToolbox, html_to_text


def _client(handler, **config):
    cfg = DeployConfig.from_payload({
        "organization_id": "acme", "deployment_id": "docs", "token": "tok-123456789",
        "portal_base_url": "https://docs.acme.com", **config,
    })
    return DeployClient(cfg, transport=httpx.MockTransport(handler))


def test_config_rejects_an_org_that_is_not_a_hostname_label():
    for bad in ("https://acme.deploy.heretto.com", "acme.evil.com", "a/b", "-acme"):
        with pytest.raises(ValueError):
            DeployConfig.from_payload({"organization_id": bad, "deployment_id": "d", "token": "t"})


def test_config_requires_the_three_values():
    with pytest.raises(ValueError):
        DeployConfig.from_payload({"organization_id": "acme", "deployment_id": "", "token": "t"})


def test_html_to_text_keeps_structure():
    text = html_to_text(
        "<h1>Install</h1><p>Run   the <b>installer</b>.</p><ol><li>One</li><li>Two</li></ol>"
        "<pre>npm  install</pre><script>alert(1)</script>"
    )
    assert "## Install" in text
    assert "Run the installer." in text
    assert "- One" in text and "- Two" in text
    assert "npm  install" in text
    assert "alert" not in text


def test_search_sends_auth_audience_and_locale_and_links_results():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["headers"] = request.headers
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"totalResults": 1, "hits": [{
            "title": "Getting started", "href": "guide/start", "shortDescription": "First steps",
            "highlights": ["the <em>start</em> page"], "breadcrumbs": [{"title": "Guide"}],
        }]})

    box = DeployToolbox(client=_client(handler, audience="customers"), locale="fr-CA")
    result = json.loads(asyncio.run(box.execute("search_docs", {"query": "start"})))

    assert seen["url"].startswith("https://acme.deploy.heretto.com/v4/deployments/docs/search")
    assert "audience=customers" in seen["url"]
    assert seen["headers"]["x-deploy-api-auth"] == "tok-123456789"
    assert seen["headers"]["accept-language"] == "fr-CA"
    assert seen["body"]["queryString"] == "start"
    hit = result["results"][0]
    assert hit["link_markdown"] == "[Getting started](https://docs.acme.com/guide/start)"
    assert hit["snippets"] == ["the start page"]
    assert hit["breadcrumbs"] == "Guide"


def test_read_topic_flattens_content_and_remembers_the_source():
    def handler(request):
        assert request.url.params["for-path"] == "guide/start"
        return httpx.Response(200, json={
            "title": "Getting started", "href": "guide/start",
            "content": "<p>Hello <a href='x'>world</a></p>",
            "children": [{"title": "Next", "href": "guide/next"}],
        })

    box = DeployToolbox(client=_client(handler))
    result = json.loads(asyncio.run(box.execute("read_topic", {"path": "guide/start"})))
    assert result["text"] == "Hello world"
    assert result["children"] == [{"title": "Next", "path": "guide/next"}]
    assert [(s.title, s.url) for s in box.sources] == [
        ("Getting started", "https://docs.acme.com/guide/start")
    ]


def test_api_errors_come_back_to_the_model_as_text_not_exceptions():
    box = DeployToolbox(client=_client(lambda r: httpx.Response(401, text="nope")))
    result = json.loads(asyncio.run(box.execute("search_docs", {"query": "x"})))
    assert "rejected the token" in result["error"]


def test_redirects_are_not_followed():
    client = _client(lambda r: httpx.Response(302, headers={"Location": "http://169.254.169.254/"}))
    with pytest.raises(DeployError):
        asyncio.run(client.get_deployment())
