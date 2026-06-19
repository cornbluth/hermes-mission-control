#!/usr/bin/env python3
import http.server
import socketserver
import os

os.chdir('/home/jlucivero/hermes-dashboard')

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        return super().do_GET()
    
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

with socketserver.TCPServer(('', 3005), Handler) as httpd:
    print('Serving hermes-dashboard on port 3005')
    httpd.serve_forever()
