"""
Middleware for ComfyUI's /api/view endpoint.

1. **Subfolder-in-filename fix.** The Nodes 2.0 frontend's
   ``WidgetSelectDropdown.vue`` constructs thumbnail URLs by passing the full
   combo value (e.g. ``subfolder/image.png``) as a single ``filename`` query
   parameter::

       /api/view?filename=subfolder%2Fimage.png&type=input

   The backend's ``/view`` handler calls ``os.path.basename(filename)`` which
   strips the subfolder portion, then looks for the file in the root input
   directory -- resulting in a 404. This middleware rewrites such requests to
   the correct form (``filename=image.png&subfolder=subfolder``) when no
   ``subfolder`` param is present.

   Upstream fix: https://github.com/Comfy-Org/ComfyUI_frontend/pull/12438
   Once merged, this rewrite becomes a harmless no-op.

2. **Virtual custom-folder subfolders.** Requests whose subfolder starts with
   ``__enhutils__/`` are served in place from folders registered by the
   ImageLoadWithSubfolders node (see ``nodes/image_load_routes.py``).
"""

import logging

from aiohttp import web

import server

from .nodes.image_load_routes import serve_virtual_view

logger = logging.getLogger("enhutils.middleware")


@web.middleware
async def fix_view_subfolder(request: web.Request, handler):
    """Split subfolder out of ``filename`` and serve virtual custom-folder paths.

    The split only activates when ``filename`` contains a ``/`` and no
    ``subfolder`` param is present. The rewrite is transparent to the handler
    -- it receives a cloned request with corrected query parameters.
    """
    if request.path not in ("/view", "/api/view"):
        return await handler(request)

    query = request.rel_url.query
    filename = query.get("filename", "")
    subfolder = query.get("subfolder", "")

    if "/" in filename and "subfolder" not in query:
        last_slash = filename.rfind("/")
        subfolder = filename[:last_slash]
        filename = filename[last_slash + 1:]

        new_query = dict(query)
        new_query["filename"] = filename
        new_query["subfolder"] = subfolder
        request = request.clone(rel_url=request.rel_url.with_query(new_query))
        logger.debug("Rewrote /view query: filename=%s subfolder=%s", filename, subfolder)

    if query.get("type", "input") == "input":
        response = serve_virtual_view(subfolder, filename, request.rel_url.query)
        if response is not None:
            return response

    return await handler(request)


# Register the middleware.  Custom node __init__.py runs before the aiohttp app
# is frozen (before AppRunner.setup()), so app.middlewares is still mutable.
server.PromptServer.instance.app.middlewares.append(fix_view_subfolder)
