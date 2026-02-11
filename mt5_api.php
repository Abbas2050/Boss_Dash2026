<?php
// MT5 API Backend - Handles MT5 Web API requests from React app
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

error_reporting(E_ALL);
ini_set('display_errors', 0); // Don't display errors in production
ini_set('memory_limit', '512M');

// MT5 Web API Client Class
class MT5Client {
    private $curl = null;
    private $server = "";
    private $authenticated = false;
    private $lastError = "";
    private $lastResponse = "";
    private $lastHttpCode = 0;
    
    // MT5 Configuration
    private $config = [
        'server' => 'mt5.skylinkstrader.com:443',
        'login' => 1023,
        'password' => 'Ab@it1023sky#',
        'build' => 4330,
        'agent' => 'WebAPI'
    ];

    public function __construct() {
        // Can override config if needed
    }

    public function init() {
        $this->shutdown();
        
        $this->curl = curl_init();
        if($this->curl == null) {
            $this->lastError = "Failed to initialize cURL";
            return false;
        }
        
        curl_setopt_array($this->curl, [
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => false,
            CURLOPT_MAXCONNECTS => 1,
            CURLOPT_HTTPHEADER => ['Connection: Keep-Alive'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HEADER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_USERAGENT => 'MT5-WebAPI-Client/1.0',
            CURLOPT_COOKIEFILE => '',
            CURLOPT_COOKIEJAR => '',
        ]);
        
        $this->server = $this->config['server'];
        return true;
    }

    public function shutdown() {
        if($this->curl != null) {
            curl_close($this->curl);
        }
        $this->curl = null;
        $this->authenticated = false;
    }

    private function executeRequest($path, $isPost = false, $postData = null) {
        if($this->curl == null) {
            $this->lastError = "cURL not initialized";
            return false;
        }
        
        curl_setopt($this->curl, CURLOPT_POST, $isPost);
        curl_setopt($this->curl, CURLOPT_URL, 'https://' . $this->server . $path);
        
        if($isPost && $postData !== null) {
            curl_setopt($this->curl, CURLOPT_POSTFIELDS, $postData);
        }
        
        $response = curl_exec($this->curl);
        $this->lastHttpCode = curl_getinfo($this->curl, CURLINFO_HTTP_CODE);
        
        if($response === false) {
            $this->lastError = 'CURL error: ' . curl_error($this->curl);
            return false;
        }
        
        $headerSize = curl_getinfo($this->curl, CURLINFO_HEADER_SIZE);
        $body = substr($response, $headerSize);
        
        $this->lastResponse = $body;
        return $body;
    }

    public function authenticate() {
        if(!$this->init()) {
            return false;
        }
        
        // Step 1: Auth start
        $path = sprintf(
            '/api/auth/start?version=%d&agent=%s&login=%d&type=manager',
            $this->config['build'],
            urlencode($this->config['agent']),
            $this->config['login']
        );
        
        $result = $this->executeRequest($path);
        if($result === false) {
            return false;
        }
        
        $authStart = json_decode($result);
        if(!$authStart || !isset($authStart->retcode) || (int)$authStart->retcode != 0) {
            $this->lastError = "Auth start failed: " . ($authStart->retcode ?? 'Unknown');
            return false;
        }
        
        if(!isset($authStart->srv_rand)) {
            $this->lastError = "No srv_rand in auth response";
            return false;
        }
        
        // Step 2: Process challenge
        $password = $this->config['password'];
        $passwordUtf16 = mb_convert_encoding($password, 'UTF-16LE', 'UTF-8');
        $passwordMd5 = md5($passwordUtf16, true);
        $passwordHash = md5($passwordMd5 . 'WebAPI', true);
        
        $srvRandBin = hex2bin($authStart->srv_rand);
        if($srvRandBin === false) {
            $this->lastError = "Failed to convert srv_rand from hex";
            return false;
        }
        
        $srvRandAnswer = md5($passwordHash . $srvRandBin);
        $cliRandBuf = random_bytes(16);
        $cliRand = bin2hex($cliRandBuf);
        
        // Step 3: Auth answer
        $path = '/api/auth/answer?srv_rand_answer=' . $srvRandAnswer . '&cli_rand=' . $cliRand;
        $result = $this->executeRequest($path);
        if($result === false) {
            return false;
        }
        
        $authAnswer = json_decode($result);
        if(!$authAnswer || !isset($authAnswer->retcode) || (int)$authAnswer->retcode != 0) {
            $this->lastError = "Auth answer failed: " . ($authAnswer->retcode ?? 'Unknown');
            return false;
        }
        
        if(!isset($authAnswer->cli_rand_answer)) {
            $this->lastError = "No cli_rand_answer in response";
            return false;
        }
        
        // Step 4: Verify server response
        $expectedCliRandAnswer = md5($passwordHash . $cliRandBuf);
        if($expectedCliRandAnswer != $authAnswer->cli_rand_answer) {
            $this->lastError = "Auth verification failed";
            return false;
        }
        
        $this->authenticated = true;
        return true;
    }

    public function getUser($login) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }
        
        $result = $this->executeRequest('/api/user/get?login=' . intval($login));
        if($result === false) {
            return null;
        }
        
        $data = json_decode($result, true);
        if(!$data || !isset($data['answer'])) {
            $this->lastError = "Invalid response format";
            return null;
        }
        
        return $data['answer'];
    }

    public function getUsers($logins = []) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }
        
        $users = [];
        foreach($logins as $login) {
            $user = $this->getUser($login);
            if($user) {
                $users[] = $user;
            }
        }
        return $users;
    }

    public function getAccount($login) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }
        
        $result = $this->executeRequest('/api/account/get?login=' . intval($login));
        if($result === false) {
            return null;
        }
        
        $data = json_decode($result, true);
        if(!$data || !isset($data['answer'])) {
            return null;
        }
        
        return $data['answer'];
    }

    public function getAccountsBatch($logins = [], $groups = []) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        $path = '/api/user/account/get_batch';
        if(!empty($groups)) {
            $groupsParam = implode(',', $groups);
            $path .= '?group=' . urlencode($groupsParam);
        } else {
            $loginsParam = implode(',', array_map('intval', $logins));
            $path .= '?login=' . $loginsParam;
        }

        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getUserLogins($groups = []) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        if(empty($groups)) {
            $this->lastError = "Groups parameter required";
            return null;
        }

        $groupsParam = implode(',', $groups);
        $path = '/api/user/logins?group=' . urlencode($groupsParam);

        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getTrades($login, $from = null, $to = null) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }
        
        $path = '/api/deal/get_batch?login=' . intval($login);
        if($from) $path .= '&from=' . intval($from);
        if($to) $path .= '&to=' . intval($to);
        
        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }
        
        $data = json_decode($result, true);
        return $data;
    }

    public function getDealsTotal($login, $from = null, $to = null) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        $path = '/api/deal/get_total?login=' . intval($login);
        if($from) $path .= '&from=' . intval($from);
        if($to) $path .= '&to=' . intval($to);

        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getDealsBatch($logins = [], $from = null, $to = null, $groups = []) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        $path = '/api/deal/get_batch';
        if(!empty($groups)) {
            $groupsParam = implode(',', $groups);
            $path .= '?group=' . urlencode($groupsParam);
        } else {
            $loginsParam = implode(',', array_map('intval', $logins));
            $path .= '?login=' . $loginsParam;
        }
        if($from) $path .= '&from=' . intval($from);
        if($to) $path .= '&to=' . intval($to);

        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getPositionsTotal($login) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        $path = '/api/position/get_total?login=' . intval($login);

        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getPositionsBatch($logins = [], $groups = []) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        $path = '/api/position/get_batch';
        if(!empty($groups)) {
            $groupsParam = implode(',', $groups);
            $path .= '?group=' . urlencode($groupsParam);
        } else {
            $loginsParam = implode(',', array_map('intval', $logins));
            $path .= '?login=' . $loginsParam;
        }

        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getDailyReports($login, $from, $to) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        $path = '/api/daily/get?login=' . intval($login) . '&from=' . intval($from) . '&to=' . intval($to);
        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getDailyReportsBatch($from, $to, $logins = [], $groups = []) {
        if(!$this->authenticated) {
            $this->lastError = "Not authenticated";
            return null;
        }

        $path = '/api/daily/get_batch';
        if(!empty($groups)) {
            $groupsParam = implode(',', $groups);
            $path .= '?group=' . urlencode($groupsParam);
        } else {
            $loginsParam = implode(',', array_map('intval', $logins));
            $path .= '?login=' . $loginsParam;
        }
        $path .= '&from=' . intval($from) . '&to=' . intval($to);
        $result = $this->executeRequest($path);
        if($result === false) {
            return null;
        }

        return json_decode($result, true);
    }

    public function getLastError() {
        return $this->lastError;
    }

    public function getLastHttpCode() {
        return $this->lastHttpCode;
    }
}

// API Router
function handleRequest() {
    $method = $_SERVER['REQUEST_METHOD'];
    $path = $_GET['endpoint'] ?? '';
    
    $mt5 = new MT5Client();
    
    // Authenticate
    if(!$mt5->authenticate()) {
        return [
            'success' => false,
            'error' => 'MT5 authentication failed: ' . $mt5->getLastError()
        ];
    }
    
    // Route requests
    $chunkLogins = function(array $logins, int $size = 200) {
        return array_chunk($logins, $size);
    };

    switch($path) {
        case 'user':
            $login = $_GET['login'] ?? null;
            if(!$login) {
                return ['success' => false, 'error' => 'Login parameter required'];
            }
            
            $user = $mt5->getUser($login);
            $mt5->shutdown();
            
            if($user === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }
            
            return ['success' => true, 'data' => $user];
            
        case 'users':
            $loginsParam = $_GET['logins'] ?? $_POST['logins'] ?? null;
            
            if(!$loginsParam) {
                return ['success' => false, 'error' => 'Logins parameter required'];
            }
            
            // Handle both JSON array and comma-separated string
            if(is_string($loginsParam)) {
                $logins = json_decode($loginsParam);
                if(!$logins) {
                    $logins = explode(',', $loginsParam);
                }
            } else {
                $logins = $loginsParam;
            }
            
            $users = $mt5->getUsers($logins);
            $mt5->shutdown();
            
            return ['success' => true, 'data' => $users];
            
        case 'account':
            $login = $_GET['login'] ?? null;
            if(!$login) {
                return ['success' => false, 'error' => 'Login parameter required'];
            }
            
            $account = $mt5->getAccount($login);
            $mt5->shutdown();
            
            if($account === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }
            
            return ['success' => true, 'data' => $account];

        case 'accounts-batch':
            $loginsParam = $_GET['logins'] ?? $_POST['logins'] ?? null;
            $groupsParam = $_GET['groups'] ?? $_POST['groups'] ?? null;

            if(!$loginsParam && !$groupsParam) {
                return ['success' => false, 'error' => 'logins or groups parameter required'];
            }

            $logins = [];
            if($loginsParam) {
                if(is_string($loginsParam)) {
                    $logins = json_decode($loginsParam);
                    if(!$logins) {
                        $logins = explode(',', $loginsParam);
                    }
                } else {
                    $logins = $loginsParam;
                }
            }

            $groups = [];
            if($groupsParam) {
                if(is_string($groupsParam)) {
                    $groups = json_decode($groupsParam);
                    if(!$groups) {
                        $groups = explode(',', $groupsParam);
                    }
                } else {
                    $groups = $groupsParam;
                }
            }

            if(empty($logins) && !empty($groups)) {
                $loginsResponse = $mt5->getUserLogins($groups);
                if($loginsResponse === null || !isset($loginsResponse['answer']) || !is_array($loginsResponse['answer'])) {
                    $mt5->shutdown();
                    return ['success' => false, 'error' => $mt5->getLastError() ?: 'Failed to resolve logins'];
                }
                $logins = $loginsResponse['answer'];
                $groups = [];
            }

            $allAccounts = [];
            foreach($chunkLogins($logins) as $chunk) {
                $accounts = $mt5->getAccountsBatch($chunk, []);
                if($accounts === null) {
                    $mt5->shutdown();
                    return ['success' => false, 'error' => $mt5->getLastError()];
                }
                if(isset($accounts['answer']) && is_array($accounts['answer'])) {
                    $allAccounts = array_merge($allAccounts, $accounts['answer']);
                }
            }

            $mt5->shutdown();
            return ['success' => true, 'data' => $allAccounts];

        case 'user-logins':
            $groupsParam = $_GET['groups'] ?? $_POST['groups'] ?? null;

            if(!$groupsParam) {
                return ['success' => false, 'error' => 'groups parameter required'];
            }

            $groups = [];
            if($groupsParam) {
                if(is_string($groupsParam)) {
                    $groups = json_decode($groupsParam);
                    if(!$groups) {
                        $groups = explode(',', $groupsParam);
                    }
                } else {
                    $groups = $groupsParam;
                }
            }

            $logins = $mt5->getUserLogins($groups);
            $mt5->shutdown();

            if($logins === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }

            return ['success' => true, 'data' => $logins['answer'] ?? []];
            
        case 'trades':
            $login = $_GET['login'] ?? null;
            $from = $_GET['from'] ?? null;
            $to = $_GET['to'] ?? null;
            
            if(!$login) {
                return ['success' => false, 'error' => 'Login parameter required'];
            }
            
            $trades = $mt5->getTrades($login, $from, $to);
            $mt5->shutdown();
            
            if($trades === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }
            
            return ['success' => true, 'data' => $trades];

        case 'deal-total':
            $login = $_GET['login'] ?? null;
            $from = $_GET['from'] ?? null;
            $to = $_GET['to'] ?? null;

            if(!$login) {
                return ['success' => false, 'error' => 'Login parameter required'];
            }

            $total = $mt5->getDealsTotal($login, $from, $to);
            $mt5->shutdown();

            if($total === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }

            return ['success' => true, 'data' => $total['answer'] ?? null];

        case 'deals-batch':
            $loginsParam = $_GET['logins'] ?? $_POST['logins'] ?? null;
            $groupsParam = $_GET['groups'] ?? $_POST['groups'] ?? null;
            $from = $_GET['from'] ?? null;
            $to = $_GET['to'] ?? null;

            if(!$loginsParam && !$groupsParam) {
                return ['success' => false, 'error' => 'Logins or groups parameter required'];
            }

            $logins = [];
            if($loginsParam) {
                if(is_string($loginsParam)) {
                    $logins = json_decode($loginsParam);
                    if(!$logins) {
                        $logins = explode(',', $loginsParam);
                    }
                } else {
                    $logins = $loginsParam;
                }
            }

            $groups = [];
            if($groupsParam) {
                if(is_string($groupsParam)) {
                    $groups = json_decode($groupsParam);
                    if(!$groups) {
                        $groups = explode(',', $groupsParam);
                    }
                } else {
                    $groups = $groupsParam;
                }
            }

            $deals = $mt5->getDealsBatch($logins, $from, $to, $groups);
            $mt5->shutdown();

            if($deals === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }

            return ['success' => true, 'data' => $deals['answer'] ?? []];

        case 'position-total':
            $login = $_GET['login'] ?? null;

            if(!$login) {
                return ['success' => false, 'error' => 'Login parameter required'];
            }

            $total = $mt5->getPositionsTotal($login);
            $mt5->shutdown();

            if($total === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }

            return ['success' => true, 'data' => $total['answer'] ?? null];

        case 'positions-batch':
            $loginsParam = $_GET['logins'] ?? $_POST['logins'] ?? null;
            $groupsParam = $_GET['groups'] ?? $_POST['groups'] ?? null;

            if(!$loginsParam && !$groupsParam) {
                return ['success' => false, 'error' => 'Logins or groups parameter required'];
            }

            $logins = [];
            if($loginsParam) {
                if(is_string($loginsParam)) {
                    $logins = json_decode($loginsParam);
                    if(!$logins) {
                        $logins = explode(',', $loginsParam);
                    }
                } else {
                    $logins = $loginsParam;
                }
            }

            $groups = [];
            if($groupsParam) {
                if(is_string($groupsParam)) {
                    $groups = json_decode($groupsParam);
                    if(!$groups) {
                        $groups = explode(',', $groupsParam);
                    }
                } else {
                    $groups = $groupsParam;
                }
            }

            if(empty($logins) && !empty($groups)) {
                $loginsResponse = $mt5->getUserLogins($groups);
                if($loginsResponse === null || !isset($loginsResponse['answer']) || !is_array($loginsResponse['answer'])) {
                    $mt5->shutdown();
                    return ['success' => false, 'error' => $mt5->getLastError() ?: 'Failed to resolve logins'];
                }
                $logins = $loginsResponse['answer'];
                $groups = [];
            }

            $allPositions = [];
            foreach($chunkLogins($logins) as $chunk) {
                $positions = $mt5->getPositionsBatch($chunk, []);
                if($positions === null) {
                    $mt5->shutdown();
                    return ['success' => false, 'error' => $mt5->getLastError()];
                }
                if(isset($positions['answer']) && is_array($positions['answer'])) {
                    $allPositions = array_merge($allPositions, $positions['answer']);
                }
            }

            $mt5->shutdown();
            return ['success' => true, 'data' => $allPositions];

        case 'daily':
            $login = $_GET['login'] ?? null;
            $from = $_GET['from'] ?? null;
            $to = $_GET['to'] ?? null;

            if(!$login || !$from || !$to) {
                return ['success' => false, 'error' => 'login, from and to parameters required'];
            }

            $report = $mt5->getDailyReports($login, $from, $to);
            $mt5->shutdown();

            if($report === null) {
                return ['success' => false, 'error' => $mt5->getLastError()];
            }

            return ['success' => true, 'data' => $report['answer'] ?? []];

        case 'daily-batch':
            $loginsParam = $_GET['logins'] ?? $_POST['logins'] ?? null;
            $groupsParam = $_GET['groups'] ?? $_POST['groups'] ?? null;
            $from = $_GET['from'] ?? null;
            $to = $_GET['to'] ?? null;

            if((!$loginsParam && !$groupsParam) || !$from || !$to) {
                return ['success' => false, 'error' => 'logins or groups, from and to parameters required'];
            }

            $logins = [];
            if($loginsParam) {
                if(is_string($loginsParam)) {
                    $logins = json_decode($loginsParam);
                    if(!$logins) {
                        $logins = explode(',', $loginsParam);
                    }
                } else {
                    $logins = $loginsParam;
                }
            }

            $groups = [];
            if($groupsParam) {
                if(is_string($groupsParam)) {
                    $groups = json_decode($groupsParam);
                    if(!$groups) {
                        $groups = explode(',', $groupsParam);
                    }
                } else {
                    $groups = $groupsParam;
                }
            }

            if(empty($logins) && !empty($groups)) {
                $loginsResponse = $mt5->getUserLogins($groups);
                if($loginsResponse === null || !isset($loginsResponse['answer']) || !is_array($loginsResponse['answer'])) {
                    $mt5->shutdown();
                    return ['success' => false, 'error' => $mt5->getLastError() ?: 'Failed to resolve logins'];
                }
                $logins = $loginsResponse['answer'];
                $groups = [];
            }

            $allReports = [];
            foreach($chunkLogins($logins) as $chunk) {
                $reports = $mt5->getDailyReportsBatch($from, $to, $chunk, []);
                if($reports === null) {
                    $mt5->shutdown();
                    return ['success' => false, 'error' => $mt5->getLastError()];
                }
                if(isset($reports['answer']) && is_array($reports['answer'])) {
                    $allReports = array_merge($allReports, $reports['answer']);
                }
            }

            $mt5->shutdown();
            return ['success' => true, 'data' => $allReports];
            
        case 'ping':
            $mt5->shutdown();
            return ['success' => true, 'message' => 'MT5 connection OK'];
            
        default:
            $mt5->shutdown();
            return ['success' => false, 'error' => 'Unknown endpoint: ' . $path];
    }
}

// Execute and return JSON
try {
    $response = handleRequest();
    echo json_encode($response);
} catch(Exception $e) {
    echo json_encode([
        'success' => false,
        'error' => 'Server error: ' . $e->getMessage()
    ]);
}
