import React from "react";
import { SafeAreaView, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";

import { CameraScreen } from "./src/screens/CameraScreen";

export default function App(): React.ReactElement {
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea}>
        <CameraScreen />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#EEF3F7"
  },
  safeArea: {
    flex: 1
  }
});
