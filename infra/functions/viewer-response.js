// CloudFront Function (viewer-response, cloudfront-js-2.0)。
// AgentCore の 401 応答の WWW-Authenticate を façade 自身の Protected Resource Metadata に向ける（REQ-051）。
function handler(event) {
  var response = event.response;
  if (response.statusCode === 401) {
    var self = 'https://' + event.request.headers.host.value;
    response.headers['www-authenticate'] = {
      value: 'Bearer resource_metadata="' + self + '/.well-known/oauth-protected-resource"'
    };
  }
  return response;
}
