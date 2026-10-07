# The JavaScript bindings whitelist for the phone scanner's opencv.js (T-0323).
#
# build_opencv_js.sh passes this file to OpenCV's platforms/js/build_js.py (--config). OpenCV's
# embindgen executes it with `makeWhiteList` defined, and only the functions and classes listed
# here get JavaScript bindings; everything the linker cannot then reach is dropped, so this list
# is what decides the size of opencv.js. It starts from OpenCV 4.14.0's own
# platforms/js/opencv_js.config.py (Apache-2.0) and keeps only what the phone page needs:
#
#   - ChArUco board detection (src/web/src/lib/vision/board_detect.js, T-0323) and QR codes
#     (qr_detect.js): objdetect's aruco classes and QRCodeDetector / QRCodeDetectorAruco;
#   - the camera pose (pose.js, T-0324): calib3d's solvePnP family, Rodrigues, projectPoints,
#     findHomography, calibrateCameraExtended, undistortPoints, initUndistortRectifyMap;
#   - the rock outline (outline.js, T-0325): the imgproc filters, morphology and contour tools;
#   - core: Mat, MatVector and friends always come from OpenCV's core_bindings.cpp; the list
#     below adds the arithmetic helpers.
#
# Dropped against the stock list: dnn, video, photo, features2d (built only because calib3d
# links against it; no bindings), HOG, cascade, barcode and face detectors, and imgproc's
# drawing-heavy and rarely useful extras. Adding a name here and re-running
# build_opencv_js.sh is all it takes to export another function.

core = {
    '': [
        'absdiff', 'add', 'addWeighted', 'bitwise_and', 'bitwise_not', 'bitwise_or', 'bitwise_xor',
        'compare', 'convertScaleAbs', 'copyMakeBorder', 'countNonZero', 'determinant', 'eigen',
        'flip', 'gemm', 'hconcat', 'inRange', 'invert', 'magnitude', 'max', 'mean', 'meanStdDev',
        'merge', 'min', 'minMaxLoc', 'multiply', 'norm', 'normalize', 'perspectiveTransform',
        'reduce', 'rotate', 'setIdentity', 'solve', 'split', 'sqrt', 'subtract', 'transform',
        'transpose', 'vconcat', 'setLogLevel', 'getLogLevel', 'LUT',
    ],
    'Algorithm': [],
}

imgproc = {
    '': [
        # the outline agent's list (T-0325 brief) ...
        'cvtColor', 'resize', 'cornerSubPix', 'GaussianBlur', 'Laplacian', 'threshold',
        'adaptiveThreshold', 'erode', 'dilate', 'morphologyEx', 'getStructuringElement',
        'findContours', 'contourArea', 'convexHull', 'approxPolyDP',
        'connectedComponents', 'connectedComponentsWithStats', 'distanceTransform', 'remap',
        'warpPerspective', 'boundingRect', 'moments',
        # ... and the neighbours an outline or an overlay is likely to want next
        'arcLength', 'blur', 'boxFilter', 'medianBlur', 'bilateralFilter', 'Canny', 'Sobel',
        'Scharr', 'equalizeHist', 'createCLAHE', 'pyrDown', 'pyrUp', 'calcHist', 'integral',
        'getPerspectiveTransform', 'getAffineTransform', 'warpAffine', 'getRectSubPix',
        'convexityDefects', 'isContourConvex', 'pointPolygonTest', 'minAreaRect',
        'minEnclosingCircle', 'fitEllipse', 'fitLine', 'drawContours', 'fillPoly',
        'fillConvexPoly', 'polylines', 'line', 'circle', 'rectangle', 'floodFill', 'grabCut',
        'watershed', 'goodFeaturesToTrack', 'cornerMinEigenVal',
    ],
    'CLAHE': ['apply', 'collectGarbage', 'getClipLimit', 'getTilesGridSize', 'setClipLimit',
              'setTilesGridSize'],
}

objdetect = {
    '': ['getPredefinedDictionary', 'extendDictionary', 'drawDetectedMarkers',
         'generateImageMarker', 'drawDetectedCornersCharuco'],
    'GraphicalCodeDetector': ['decode', 'detect', 'detectAndDecode', 'detectMulti', 'decodeMulti',
                              'detectAndDecodeMulti'],
    'QRCodeDetector': ['QRCodeDetector', 'decode', 'detect', 'detectAndDecode', 'detectMulti',
                       'decodeMulti', 'detectAndDecodeMulti', 'decodeCurved',
                       'detectAndDecodeCurved', 'setEpsX', 'setEpsY'],
    'QRCodeDetectorAruco_Params': ['Params'],
    'QRCodeDetectorAruco': ['QRCodeDetectorAruco', 'decode', 'detect', 'detectAndDecode',
                            'detectMulti', 'decodeMulti', 'detectAndDecodeMulti',
                            'setDetectorParameters', 'setArucoParameters'],
    'aruco_PredefinedDictionaryType': [],
    'aruco_Dictionary': ['Dictionary', 'getDistanceToId', 'generateImageMarker',
                         'getByteListFromBits', 'getBitsFromByteList'],
    'aruco_Board': ['Board', 'matchImagePoints', 'generateImage'],
    'aruco_GridBoard': ['GridBoard', 'generateImage', 'getGridSize', 'getMarkerLength',
                        'getMarkerSeparation', 'matchImagePoints'],
    'aruco_CharucoParameters': ['CharucoParameters'],
    'aruco_CharucoBoard': ['CharucoBoard', 'generateImage', 'getChessboardCorners',
                           'getNearestMarkerCorners', 'checkCharucoCornersCollinear',
                           'matchImagePoints', 'getLegacyPattern', 'setLegacyPattern'],
    'aruco_DetectorParameters': ['DetectorParameters'],
    'aruco_RefineParameters': ['RefineParameters'],
    'aruco_ArucoDetector': ['ArucoDetector', 'detectMarkers', 'refineDetectedMarkers',
                            'setDictionary', 'setDetectorParameters', 'setRefineParameters'],
    'aruco_CharucoDetector': ['CharucoDetector', 'setBoard', 'setCharucoParameters',
                              'setDetectorParameters', 'setRefineParameters', 'detectBoard',
                              'detectDiamonds'],
}

calib3d = {
    '': [
        # the pose agent's list (T-0324 brief) ...
        'solvePnP', 'solvePnPRefineLM', 'Rodrigues', 'projectPoints', 'findHomography',
        'calibrateCameraExtended', 'undistortPoints', 'undistortPointsIter',
        'initUndistortRectifyMap',
        # ... and close relatives: every IPPE solution (solvePnPGeneric), RANSAC, VVS refinement,
        # homography decomposition and the undistortion helpers
        'solvePnPGeneric', 'solvePnPRansac', 'solvePnPRefineVVS', 'decomposeHomographyMat',
        'getOptimalNewCameraMatrix', 'getDefaultNewCameraMatrix', 'undistort',
        'undistortImagePoints', 'estimateAffine2D', 'drawFrameAxes',
    ],
    'UsacParams': ['UsacParams'],
}

white_list = makeWhiteList([core, imgproc, objdetect, calib3d])
