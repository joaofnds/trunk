import subprocess


def stop_app(app, request_quit):
    if app.poll() is not None:
        return

    try:
        request_quit()
        app.wait(timeout=5)
    except Exception:
        app.terminate()
        try:
            app.wait(timeout=5)
        except subprocess.TimeoutExpired:
            app.kill()
            app.wait(timeout=5)
